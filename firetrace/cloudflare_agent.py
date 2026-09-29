from __future__ import annotations

import json
import os
import struct
import subprocess
import time
import threading
from pathlib import Path
from urllib.parse import quote

from websockets.sync.client import connect

from .worker import Worker, ROOT, SCREENSHOT
from .runtime import load_user_environment, quiet_process_options, git_environment


def ws_url(base_url: str, agent_id: str) -> str:
    base = base_url.rstrip("/")
    if base.startswith("https://"):
        base = "wss://" + base[len("https://"):]
    elif base.startswith("http://"):
        base = "ws://" + base[len("http://"):]
    elif not base.startswith(("ws://", "wss://")):
        raise ValueError("control URL must start with https://, http://, ws:// or wss://")
    return f"{base}/ws?agent_id={quote(agent_id)}"


class CloudflareFiretraceAgent:
    def __init__(self, stop_event: threading.Event | None = None) -> None:
        load_user_environment()
        self.stop_event = stop_event or threading.Event()
        self.base_url = os.getenv("FIRETRACE_CONTROL_URL") or os.getenv("CF_CONTROL_URL")
        self.token = os.getenv("FIRETRACE_CONTROL_TOKEN") or os.getenv("CF_CONTROL_TOKEN")
        if not self.base_url or not self.token:
            raise RuntimeError("Cloudflare control URL/token are not configured")
        self.agent_id = os.getenv("FIRETRACE_AGENT_ID", "firetrace")
        self.worker = Worker()
        self.inbox = ROOT / "commands" / "inbox"
        self.results = ROOT / "commands" / "results"
        self.screenshots = ROOT / "commands" / "screenshots"
        self.inbox.mkdir(parents=True, exist_ok=True)
        self.results.mkdir(parents=True, exist_ok=True)
        self.screenshots.mkdir(parents=True, exist_ok=True)
        self.seen_inbox: set[str] = set()

    def send_json(self, ws, payload: dict) -> None:
        ws.send(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

    def send_state(self, ws, command_id: str | None = None) -> None:
        try:
            state = self.worker.backend.status()
            self.send_json(ws, {
                "type": "state",
                "agent_id": self.agent_id,
                "command_id": command_id,
                "state": state,
                "ts": time.time(),
            })
        except Exception as exc:
            self.send_json(ws, {
                "type": "event",
                "event": "state_error",
                "payload": {"error": f"{type(exc).__name__}: {exc}"},
            })

    def send_screenshot(self, ws, command_id: str, args: dict) -> dict:
        self.worker.select_browser(args.get('browser_id'))
        quality = max(20, min(int(args.get("quality", 65)), 90))
        jpg = self.worker.backend.screenshot(quality)

        header = json.dumps({
            "type": "screenshot",
            "agent_id": self.agent_id,
            "command_id": command_id,
            "mime": "image/jpeg",
            "quality": quality,
            "ts": int(time.time() * 1000),
        }, separators=(",", ":")).encode("utf-8")

        frame = struct.pack(">I", len(header)) + header + jpg
        ws.send(frame)
        return {"bytes": len(jpg), "quality": quality, "uploaded": True}

    @staticmethod
    def normalize_action(action: str) -> str:
        aliases = {
            "browser_status": "status",
            "browser_open": "open",
            "browser_screenshot": "screenshot",
            "browser_click": "click",
            "browser_click_relative": "click_relative",
            "browser_wait": "wait",
        }
        return aliases.get(action, action)

    def _git(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["git", *args],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
            timeout=30,
            env=git_environment(),
            **quiet_process_options(),
        )

    def _publish_repo_result(self, command: dict, result: dict, screenshot: bytes | None = None) -> None:
        command_id = str(command.get("id", "unknown"))
        result_path = self.results / f"{command_id}.json"
        result_path.write_text(
            json.dumps(result, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        paths = [str(result_path.relative_to(ROOT)).replace("\\", "/")]
        if screenshot is not None:
            shot_path = self.screenshots / f"{command_id}.jpg"
            shot_path.write_bytes(screenshot)
            paths.append(str(shot_path.relative_to(ROOT)).replace("\\", "/"))

        self._git("add", *paths)
        commit = self._git("commit", "-m", f"firetrace result {command_id}")
        if commit.returncode == 0:
            pushed = self._git("push", "origin", "main")
            if pushed.returncode != 0:
                self._git("pull", "--rebase", "origin", "main")
                self._git("push", "origin", "main")

    def _execute_local(self, command: dict) -> tuple[dict, bytes | None]:
        command_id = str(command.get("id", ""))
        raw_action = str(command.get("action", ""))
        action = self.normalize_action(raw_action)
        args = command.get("args") or {}
        started = time.time()
        screenshot = None
        try:
            if action == "screenshot":
                self.worker.select_browser(args.get('browser_id'))
                quality = max(20, min(int(args.get("quality", 65)), 90))
                screenshot = self.worker.backend.screenshot(quality)
                data = {"bytes": len(screenshot), "quality": quality}
            else:
                envelope = self.worker.execute({
                    "id": command_id,
                    "action": action,
                    "args": args,
                })
                data = envelope.get("data")
                if action == "sequence" and isinstance(data, dict) and data.get("screenshot"):
                    if SCREENSHOT.exists():
                        screenshot = SCREENSHOT.read_bytes()
            result = {
                "id": command_id,
                "action": raw_action,
                "ok": True,
                "data": data,
                "started_at": started,
                "finished_at": time.time(),
            }
        except Exception as exc:
            result = {
                "id": command_id,
                "action": raw_action,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "started_at": started,
                "finished_at": time.time(),
            }
        return result, screenshot

    def poll_repo_inbox(self) -> None:
        # Append-only command files avoid write conflicts on commands/current.json.
        pull = self._git("pull", "--ff-only", "origin", "main")
        if pull.returncode != 0:
            return

        for path in sorted(self.inbox.glob("*.json")):
            key = path.name
            if key in self.seen_inbox:
                continue
            result_path = self.results / path.name
            if result_path.exists():
                self.seen_inbox.add(key)
                continue
            try:
                command = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(command, dict):
                    raise ValueError("command must be a JSON object")
                result, screenshot = self._execute_local(command)
            except Exception as exc:
                command = {"id": path.stem, "action": "invalid"}
                result = {
                    "id": path.stem,
                    "action": "invalid",
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                    "finished_at": time.time(),
                }
                screenshot = None

            self._publish_repo_result(command, result, screenshot)
            self.seen_inbox.add(key)

    def handle_command(self, ws, command: dict) -> None:
        command_id = str(command.get("id", ""))
        raw_action = str(command.get("action", ""))
        action = self.normalize_action(raw_action)
        args = command.get("args") or {}
        started = time.time()

        self.send_json(ws, {
            "type": "started",
            "id": command_id,
            "action": raw_action,
            "started_at": started,
        })

        try:
            if action == "screenshot":
                result = self.send_screenshot(ws, command_id, args)
            else:
                envelope = self.worker.execute({
                    "id": command_id,
                    "action": action,
                    "args": args,
                })
                result = envelope.get("data")

            payload = {
                "type": "result",
                "id": command_id,
                "action": raw_action,
                "ok": True,
                "result": result,
                "started_at": started,
                "finished_at": time.time(),
            }
        except Exception as exc:
            payload = {
                "type": "result",
                "id": command_id,
                "action": raw_action,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "started_at": started,
                "finished_at": time.time(),
            }

        self.send_json(ws, payload)
        self.send_state(ws, command_id=command_id)

    def session(self) -> None:
        uri = ws_url(self.base_url, self.agent_id)
        print(f"Connecting Firetrace agent {self.agent_id!r} to {uri}")

        with connect(
            uri,
            additional_headers={"X-Control-Token": self.token},
            max_size=16 * 1024 * 1024,
            open_timeout=15,
            close_timeout=5,
            ping_interval=20,
            ping_timeout=20,
        ) as ws:
            print("Cloudflare WSS connected.")
            self.send_json(ws, {
                "type": "hello",
                "agent_id": self.agent_id,
                "ts": time.time(),
                "version": "0.3.1",
                "transport": "cloudflare-wss-sync",
                "backend": self.worker.backend.status().get("backend"),
            })
            self.send_state(ws)

            last_heartbeat = time.monotonic()

            while not self.stop_event.is_set():
                try:
                    raw = ws.recv(timeout=1.0)
                except TimeoutError:
                    raw = None

                now = time.monotonic()
                if now - last_heartbeat >= 10:
                    self.send_json(ws, {
                        "type": "hello",
                        "agent_id": self.agent_id,
                        "ts": time.time(),
                        "version": "0.3.1",
                        "transport": "cloudflare-wss-sync",
                    })
                    self.send_state(ws)
                    last_heartbeat = now

                if raw is None or not isinstance(raw, str):
                    continue

                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                if msg.get("type") != "command":
                    continue

                command = msg.get("command")
                if isinstance(command, dict):
                    self.handle_command(ws, command)

    def run_forever(self) -> None:
        delay = 1.0
        while not self.stop_event.is_set():
            try:
                self.session()
                delay = 1.0
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                print(f"WSS disconnected: {type(exc).__name__}: {exc}")
                print(f"Reconnecting in {delay:.1f}s...")
                self.stop_event.wait(delay)
                delay = min(delay * 1.7, 15.0)


def main(stop_event: threading.Event | None = None) -> None:
    agent = CloudflareFiretraceAgent(stop_event=stop_event)
    try:
        agent.run_forever()
    finally:
        close = getattr(agent.worker.backend, "close", None)
        if close:
            close()


if __name__ == "__main__":
    main()
