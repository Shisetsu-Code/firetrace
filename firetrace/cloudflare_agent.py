from __future__ import annotations

import asyncio
import json
import os
import struct
import time
from urllib.parse import quote

import websockets

from .worker import Worker


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
    def __init__(self) -> None:
        self.base_url = os.getenv("FIRETRACE_CONTROL_URL") or os.getenv("CF_CONTROL_URL")
        self.token = os.getenv("FIRETRACE_CONTROL_TOKEN") or os.getenv("CF_CONTROL_TOKEN")
        if not self.base_url or not self.token:
            raise RuntimeError("Cloudflare control URL/token are not configured")
        self.agent_id = os.getenv("FIRETRACE_AGENT_ID", "firetrace")
        self.worker = Worker()
        self._send_lock = asyncio.Lock()

    async def send_json(self, ws, payload: dict) -> None:
        async with self._send_lock:
            await ws.send(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

    async def send_state(self, ws, command_id: str | None = None) -> None:
        try:
            state = self.worker.backend.status()
            await self.send_json(ws, {
                "type": "state",
                "agent_id": self.agent_id,
                "command_id": command_id,
                "state": state,
                "ts": time.time(),
            })
        except Exception as exc:
            await self.send_json(ws, {
                "type": "event",
                "event": "state_error",
                "payload": {"error": f"{type(exc).__name__}: {exc}"},
            })

    async def send_screenshot(self, ws, command_id: str, args: dict) -> dict:
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
        async with self._send_lock:
            await ws.send(frame)
        return {"bytes": len(jpg), "quality": quality, "uploaded": True}

    async def heartbeat(self, ws) -> None:
        while True:
            await asyncio.sleep(10)
            await self.send_json(ws, {
                "type": "hello",
                "agent_id": self.agent_id,
                "ts": time.time(),
                "version": "0.3.0",
                "transport": "cloudflare-wss",
            })
            await self.send_state(ws)

    def _normalize_action(self, action: str) -> str:
        aliases = {
            "browser_status": "status",
            "browser_open": "open",
            "browser_screenshot": "screenshot",
            "browser_click": "click",
            "browser_click_relative": "click_relative",
            "browser_wait": "wait",
        }
        return aliases.get(action, action)

    async def handle_command(self, ws, command: dict) -> None:
        command_id = str(command.get("id", ""))
        raw_action = str(command.get("action", ""))
        action = self._normalize_action(raw_action)
        args = command.get("args") or {}
        started = time.time()

        await self.send_json(ws, {
            "type": "started",
            "id": command_id,
            "action": raw_action,
            "started_at": started,
        })

        try:
            if action == "screenshot":
                result = await self.send_screenshot(ws, command_id, args)
            else:
                normalized = {"id": command_id, "action": action, "args": args}
                envelope = self.worker.execute(normalized)
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

        await self.send_json(ws, payload)
        await self.send_state(ws, command_id=command_id)

    async def session(self) -> None:
        uri = ws_url(self.base_url, self.agent_id)
        headers = {"X-Control-Token": self.token}
        print(f"Connecting Firetrace agent {self.agent_id!r} to {uri}")

        async with websockets.connect(
            uri,
            additional_headers=headers,
            max_size=16 * 1024 * 1024,
            ping_interval=20,
            ping_timeout=20,
            close_timeout=5,
        ) as ws:
            await self.send_json(ws, {
                "type": "hello",
                "agent_id": self.agent_id,
                "ts": time.time(),
                "version": "0.3.0",
                "transport": "cloudflare-wss",
                "backend": self.worker.backend.status().get("backend"),
            })
            await self.send_state(ws)

            heartbeat_task = asyncio.create_task(self.heartbeat(ws))
            try:
                async for raw in ws:
                    if not isinstance(raw, str):
                        continue
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if msg.get("type") != "command":
                        continue
                    command = msg.get("command")
                    if isinstance(command, dict):
                        await self.handle_command(ws, command)
            finally:
                heartbeat_task.cancel()
                await asyncio.gather(heartbeat_task, return_exceptions=True)

    async def run_forever(self) -> None:
        delay = 1.0
        while True:
            try:
                await self.session()
                delay = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"WSS disconnected: {type(exc).__name__}: {exc}")
                print(f"Reconnecting in {delay:.1f}s...")
                await asyncio.sleep(delay)
                delay = min(delay * 1.7, 15.0)


def main() -> None:
    asyncio.run(CloudflareFiretraceAgent().run_forever())


if __name__ == "__main__":
    main()
