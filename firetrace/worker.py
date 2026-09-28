from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

from .firecrawl import FirecrawlBackend, FirecrawlClient
from .local_browser import LocalBrowserBackend

ROOT = Path(__file__).resolve().parents[1]
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
        git("add", "commands/result.json", "commands/latest.jpg")
        git("commit", "-m", f"firetrace result {cid}")
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
