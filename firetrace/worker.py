from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from .firecrawl import FirecrawlBackend, FirecrawlClient
from .local_browser import LocalBrowserBackend

def find_repo_root() -> Path:
    candidates = []
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent)
    candidates.extend([
        Path(__file__).resolve().parents[1],
        Path.cwd(),
        Path.home() / "firetrace",
        Path.home() / "Firetrace",
    ])
    for candidate in candidates:
        if (candidate / ".git").exists() and (candidate / "pyproject.toml").exists():
            return candidate
    return candidates[0]


ROOT = find_repo_root()
COMMAND = ROOT / "commands" / "current.json"
RESULT = ROOT / "commands" / "result.json"
SCREENSHOT = ROOT / "commands" / "latest.jpg"
STATE = ROOT / ".firetrace-state.json"


def git(*args: str, check: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=True, check=check)


class Worker:
    def __init__(self):
        selected = os.getenv("FIRETRACE_BROWSER_BACKEND", "local").lower()
        if selected == "firecrawl":
            self.backend = FirecrawlBackend(
                FirecrawlClient(
                    base_url=os.getenv("FIRETRACE_FIRECRAWL_URL", "http://127.0.0.1:3002"),
                    api_key=os.getenv("FIRETRACE_FIRECRAWL_KEY") or None,
                )
            )
        else:
            self.backend = LocalBrowserBackend(
                os.getenv("FIRETRACE_CDP_URL", "http://127.0.0.1:9222")
            )
        self.last_id = self._load_last_id()

    def _load_last_id(self) -> str | None:
        try:
            return json.loads(STATE.read_text())["last_id"]
        except Exception:
            return None

    def _save_last_id(self, value: str) -> None:
        STATE.write_text(json.dumps({"last_id": value}), encoding="utf-8")

    def execute(self, command: dict) -> dict:
        action = command.get("action")
        args = command.get("args") or {}
        if action == "status":
            data = self.backend.status()
        elif action == "open":
            data = self.backend.open(args["url"])
        elif action == "wait":
            data = self.backend.wait(args.get("ms", 1000))
        elif action == "click":
            data = self.backend.click(args["x"], args["y"])
        elif action == "click_relative":
            data = self.backend.click_relative(args["rx"], args["ry"])
        elif action == "screenshot":
            SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
            SCREENSHOT.write_bytes(self.backend.screenshot(args.get("quality", 60)))
            data = {"path": "commands/latest.jpg", "bytes": SCREENSHOT.stat().st_size}
        elif action == "network_clear":
            data = self.backend.network_clear()
        elif action == "network_events":
            data = self.backend.network_events()
        elif action == "trigger_and_capture":
            data = self.backend.trigger_and_capture(**args)
        elif action == "sequence":
            steps = args.get("steps") or []
            if not isinstance(steps, list) or len(steps) > 20:
                raise ValueError("sequence.steps must be a list with at most 20 items")
            results = []
            screenshot_bytes = None
            screenshot_quality = None
            for index, step in enumerate(steps):
                if not isinstance(step, dict):
                    raise ValueError(f"invalid sequence step {index}")
                step_action = step.get("action")
                step_args = step.get("args") or {}
                if step_action == "click":
                    step_data = self.backend.click(step_args["x"], step_args["y"])
                elif step_action == "click_relative":
                    step_data = self.backend.click_relative(step_args["rx"], step_args["ry"])
                elif step_action == "wait":
                    step_data = self.backend.wait(step_args.get("ms", 500))
                elif step_action == "open":
                    step_data = self.backend.open(step_args["url"])
                elif step_action == "trigger_and_capture":
                    step_data = self.backend.trigger_and_capture(**step_args)
                elif step_action == "screenshot":
                    screenshot_quality = int(step_args.get("quality", 70))
                    screenshot_bytes = self.backend.screenshot(screenshot_quality)
                    step_data = {"bytes": len(screenshot_bytes), "quality": screenshot_quality}
                elif step_action == "status":
                    step_data = self.backend.status()
                else:
                    raise ValueError(f"unsupported sequence action: {step_action}")
                results.append({"index": index, "action": step_action, "data": step_data})

            if screenshot_bytes is not None:
                SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
                SCREENSHOT.write_bytes(screenshot_bytes)
            data = {
                "steps": results,
                "screenshot": (
                    {"path": "commands/latest.jpg", "bytes": len(screenshot_bytes), "quality": screenshot_quality}
                    if screenshot_bytes is not None else None
                ),
            }
        else:
            raise ValueError(f"unknown action: {action}")
        return {"id": command.get("id"), "ok": True, "action": action, "data": data, "ts": time.time()}

    def process_once(self) -> bool:
        git("pull", "--ff-only")
        if not COMMAND.exists():
            return False
        cmd = json.loads(COMMAND.read_text(encoding="utf-8"))
        cid = str(cmd.get("id") or "")
        if not cid or cid == self.last_id:
            return False
        try:
            result = self.execute(cmd)
        except Exception as exc:
            result = {
                "id": cid,
                "ok": False,
                "action": cmd.get("action"),
                "error": f"{type(exc).__name__}: {exc}",
                "ts": time.time(),
            }
        RESULT.parent.mkdir(parents=True, exist_ok=True)
        RESULT.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
        self.last_id = cid
        self._save_last_id(cid)
        paths = ["commands/result.json"]
        if SCREENSHOT.exists():
            paths.append("commands/latest.jpg")
        git("add", *paths)
        commit = git("commit", "-m", f"firetrace result {cid}")
        if commit.returncode == 0:
            pushed = git("push", "origin", "main")
            if pushed.returncode != 0:
                git("pull", "--rebase", "origin", "main")
                git("push", "origin", "main")
        return True

    def run(self) -> None:
        interval = float(os.getenv("FIRETRACE_POLL_SECONDS", "2"))
        print("Firetrace worker running. Ctrl+C to stop.")
        while True:
            try:
                self.process_once()
            except Exception as exc:
                print(f"worker warning: {type(exc).__name__}: {exc}")
            time.sleep(interval)
