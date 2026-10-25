"""Ephemeral GitHub Actions browser agent. No Cloudflare or user PC required.

Commands/results are append-only files in a session-specific directory. Only
redacted diagnostics are committed; detailed sanitized HARs are workflow artifacts.
This transport is for publicly shareable DEMO sessions, never authenticated sites.
"""
from __future__ import annotations

import base64
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .local_browser import LocalBrowserBackend

ROOT = Path(__file__).resolve().parents[1]
SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{3,64}$")
PRIVATE_KEY_RE = re.compile(
    r"(?:authorization|cookie|password|passwd|secret|access.?token|refresh.?token|"
    r"session.?id|api.?key|client.?secret|csrf|jwt|signature|credential|"
    r"email|bearer|auth.?token|id.?token)", re.I
)
BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9_.~+/-]{6,}")
KEY_PAIR_RE = re.compile(
    r"(?i)\b(access_token|refresh_token|session_id|api_key|password|"
    r"authorization|csrf|client_secret)=([^&\s]+)"
)


def safe_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"https", "http", "wss", "ws"}:
            return value[:300]
        host = parsed.hostname or ""
        netloc = host + (f":{parsed.port}" if parsed.port else "")
        params = [
            (key, "[REDACTED]" if PRIVATE_KEY_RE.search(key) else val[:250])
            for key, val in parse_qsl(parsed.query, keep_blank_values=True)
        ]
        return urlunsplit((parsed.scheme, netloc, parsed.path[:1024],
                           urlencode(params), ""))
    except (ValueError, TypeError):
        return "[INVALID_URL]"


def scrub(value, key: str = ""):
    """Best-effort protection for public GitHub results (not a DLP guarantee)."""
    if PRIVATE_KEY_RE.search(key):
        return "[REDACTED]"
    if isinstance(value, dict):
        # HAR headers are name/value records, not dictionaries keyed by header.
        if "name" in value and "value" in value and PRIVATE_KEY_RE.search(str(value["name"])):
            return {**value, "value": "[REDACTED]"}
        return {str(k): scrub(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(item) for item in value[:5000]]
    if isinstance(value, str):
        if key.lower() in {"url", "href", "documenturl", "frameid"}:
            return safe_url(value)
        if key.lower() in {"text", "postdata", "payloaddata", "responsebody", "body"}:
            if len(value) > 16384:
                return f"[BODY OMITTED: {len(value)} characters]"
            try:
                return json.dumps(scrub(json.loads(value)), ensure_ascii=False)
            except (ValueError, TypeError):
                pass
            if "<html" in value[:100].lower() or "<!doctype" in value[:100].lower():
                return "[HTML OMITTED]"
            if "=" in value and ("&" in value or key.lower() == "postdata"):
                try:
                    pairs = parse_qsl(value, keep_blank_values=True, strict_parsing=True)
                    if pairs:
                        return urlencode([(k, "[REDACTED]" if PRIVATE_KEY_RE.search(k)
                                           else v) for k, v in pairs])
                except ValueError:
                    pass
        value = BEARER_RE.sub("Bearer [REDACTED]", value)
        value = KEY_PAIR_RE.sub(lambda m: m.group(1) + "=[REDACTED]", value)
        return value[:20000]
    return value


def validate_demo_url(value: str, allowed_hosts: list[str]) -> None:
    parsed = urlsplit(value)
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme != "https" or parsed.username or parsed.password or not hostname:
        raise ValueError("Only public HTTPS demo URLs without embedded credentials are allowed")
    if hostname == "localhost" or hostname.endswith((".local", ".internal")):
        raise ValueError("Local/internal hosts are forbidden")
    try:
        address = ipaddress.ip_address(hostname)
        if not address.is_global:
            raise ValueError("Non-public address forbidden")
    except ValueError as exc:
        if str(exc) == "Non-public address forbidden":
            raise
    if not any(hostname == h or hostname.endswith("." + h) for h in allowed_hosts):
        raise ValueError("Domain is not in remote/start.json allowed_hosts")


def summarize_har(har: dict) -> dict:
    routes = {}
    ws_count = 0
    for entry in har.get("log", {}).get("entries", []):
        req = entry.get("request") or {}
        url = req.get("url") or ""
        parsed = urlsplit(url)
        path = parsed.path or "/"
        method = req.get("method", "GET")
        key = f"{method} {parsed.hostname or ''}{path}"
        route = routes.setdefault(key, {
            "method": method, "host": parsed.hostname, "path": path,
            "count": 0, "statuses": {}, "query_keys": [], "request_example": None,
            "response_example": None, "websocket_frames": 0
        })
        route["count"] += 1
        status = str((entry.get("response") or {}).get("status", 0))
        route["statuses"][status] = route["statuses"].get(status, 0) + 1
        route["query_keys"] = sorted(set(route["query_keys"]) |
                                     {k for k, _ in parse_qsl(parsed.query)})
        post = req.get("postData") or {}
        body = (entry.get("response") or {}).get("content") or {}
        if route["request_example"] is None and post.get("text"):
            route["request_example"] = post["text"][:2000]
        if route["response_example"] is None and body.get("text") and not body.get("encoding"):
            route["response_example"] = body["text"][:2000]
        frames = entry.get("_webSocketFrames") or []
        ws_count += len(frames)
        route["websocket_frames"] += len(frames)
    return {"http_entries": len(har.get("log", {}).get("entries", [])),
            "ws_frames": ws_count, "endpoints": list(routes.values())}


def git(*args: str, check: bool = True):
    result = subprocess.run(["git", *args], cwd=ROOT, capture_output=True,
                            text=True, timeout=40, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    if check and result.returncode:
        raise RuntimeError(f"git {args[0]} failed: {result.stderr[-500:]}")
    return result


def publish(paths: list[Path], description: str) -> None:
    relative = [str(path.relative_to(ROOT)) for path in paths]
    git("add", "--", *relative)
    git("commit", "-m", description)
    for attempt in range(6):
        git("pull", "--rebase", "origin", "main")
        if git("push", "origin", "HEAD:main", check=False).returncode == 0:
            return
        time.sleep(1 + attempt)
    raise RuntimeError("Cannot publish result after six attempts")


class Session:
    def __init__(self, session_id: str, artifact_dir: Path, allowed_hosts: list[str]):
        self.session_id = session_id
        self.artifact_dir = artifact_dir
        self.allowed_hosts = allowed_hosts
        self.artifact_dir.mkdir(parents=True, exist_ok=True)
        self.events_path = artifact_dir / "events.jsonl"
        self.record_index = 0
        self.capture_index = 0
        self.backend = LocalBrowserBackend(cdp_url="http://127.0.0.1:1")
        self.started = time.time()
        self.backend.record_start()

    def event(self, event: dict):
        with self.events_path.open("a", encoding="utf-8") as fp:
            fp.write(json.dumps(scrub(event), ensure_ascii=False, separators=(",", ":")) + "\n")

    def capture(self) -> dict:
        self.capture_index += 1
        name = f"frame-{self.capture_index:04}.jpg"
        path = self.artifact_dir / "screenshots" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shot = self.backend.screenshot(quality=50)
        path.write_bytes(shot)
        return {"capture": f"screenshots/{name}", "size_bytes": len(shot)}

    def save_har(self) -> dict:
        self.record_index += 1
        result = self.backend.record_save()
        raw_path = Path(result["path"])
        try:
            sanitized = scrub(json.loads(raw_path.read_text(encoding="utf-8")))
            output = self.artifact_dir / "captures" / f"capture-{self.record_index:03}.har"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(sanitized, ensure_ascii=False), encoding="utf-8")
            report = summarize_har(sanitized)
            report_path = output.with_suffix(".json")
            report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
            return {"capture": f"captures/{output.name}", "report": f"captures/{report_path.name}",
                    "entries": report["http_entries"], "ws_frames": report["ws_frames"],
                    "endpoints": report["endpoints"][:50],
                    "truncated_endpoints": max(0, len(report["endpoints"]) - 50)}
        finally:
            raw_path.unlink(missing_ok=True)

    def inspect(self) -> dict:
        frames = []
        for frame in self.backend.page.frames[:20]:
            try:
                controls = frame.evaluate("""() => Array.from(document.querySelectorAll(
                  'button,[role="button"],input[type="button"],input[type="submit"],a'
                )).slice(0,100).map(el => {
                   const b=el.getBoundingClientRect();
                   return {text:(el.innerText||el.getAttribute('aria-label')||el.value||'')
                       .trim().slice(0,120),x:b.x,y:b.y,w:b.width,h:b.height,
                     disabled:el.disabled===true};
                }).filter(x=>x.w>2&&x.h>2).slice(0,40)""")
                frames.append({"url":safe_url(frame.url), "controls":controls,
                               "text":frame.evaluate("() => document.body?.innerText?.slice(0,1200)||''")})
            except Exception as exc:
                frames.append({"url":safe_url(frame.url), "error":type(exc).__name__})
        return {"frames":frames, "viewport":self.backend.page.viewport_size}

    def execute(self, cmd: dict) -> tuple[dict, bool]:
        action = cmd["action"]
        args = cmd.get("args") or {}
        stop = False
        if action == "status":
            data = {**self.backend.status(), "runtime":"github-actions",
                    "session":self.session_id, "run_id":os.getenv("GITHUB_RUN_ID"),
                    "uptime_s":int(time.time()-self.started)}
        elif action == "open":
            validate_demo_url(args["url"], self.allowed_hosts)
            data = self.backend.open(args["url"])
        elif action == "click":
            data = self.backend.click(float(args["x"]), float(args["y"]))
        elif action == "click_relative":
            data = self.backend.click_relative(float(args["rx"]), float(args["ry"]))
        elif action == "wait":
            data = self.backend.wait(min(10000, max(0, int(args.get("ms", 1000)))))
        elif action == "screenshot":
            quality = min(75, max(25, int(args.get("quality", 50))))
            shot = self.backend.screenshot(quality=quality)
            data = {"mime_type":"image/jpeg", "bytes":len(shot),
                    "image_base64":base64.b64encode(shot).decode("ascii")}
            self.capture_index += 1
            target = self.artifact_dir / "screenshots" / f"frame-{self.capture_index:04}.jpg"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(shot)
        elif action == "inspect":
            data = self.inspect()
        elif action == "record_status":
            data = self.backend.record_status()
        elif action == "record_start":
            data = self.backend.record_start()
        elif action in {"record_save", "network_report"}:
            data = self.save_har()
            if action == "network_report":
                self.backend.record_start()
        elif action == "trigger_and_capture":
            data = self.backend.trigger_and_capture(
                url_contains=str(args.get("url_contains", ""))[:200],
                rx=float(args["rx"]), ry=float(args["ry"]),
                wait_ms=min(10000, int(args.get("wait_ms", 2500))))
        elif action == "note":
            data = {"note":str(args.get("text", ""))[:2000],
                    "tags":[str(x)[:50] for x in args.get("tags", [])[:15]]}
        elif action == "stop":
            data = {"stopped":True}
            stop = True
        else:
            raise ValueError("Unsupported remote action")
        if action in {"open", "click", "click_relative", "trigger_and_capture"}:
            data = {**data, **self.capture()}
        self.event({"time":time.time(), "command_id":cmd["id"],
                    "action":action, "args":args,
                    "result":({k:v for k,v in data.items() if k!="image_base64"})})
        return scrub(data), stop

    def close(self) -> None:
        try:
            if self.backend.record_status()["recording"]:
                self.save_har()
        except Exception as exc:
            self.event({"event":"close_capture_error", "error":str(exc)})
        finally:
            self.backend.close()


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", default="")
    options = parser.parse_args()
    config = json.loads((ROOT / "remote" / "start.json").read_text(encoding="utf-8"))
    session_id = options.session or config.get("session_id", "")
    if not SESSION_RE.fullmatch(session_id):
        raise SystemExit("Invalid session ID")
    allowed = config.get("allowed_hosts") or ["pragmaticplay.fun"]
    if not isinstance(allowed, list) or not allowed or not all(
        isinstance(x, str) and re.fullmatch(r"[a-z0-9.-]{3,100}", x) for x in allowed
    ):
        raise SystemExit("Invalid allowed_hosts")
    duration = min(120, max(5, int(config.get("minutes", 45)))) * 60
    idle = min(1800, max(60, int(config.get("idle_seconds", 900))))
    base = ROOT / "remote" / "sessions" / session_id
    inbox, outbox = base / "inbox", base / "results"
    outbox.mkdir(parents=True, exist_ok=True)
    artifact_dir = Path(os.getenv("FIRETRACE_ARTIFACT_DIR",
                                  "/tmp/firetrace-artifacts")) / session_id
    stop_signal = False
    def request_stop(*_):
        nonlocal stop_signal
        stop_signal = True
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    os.environ["FIRETRACE_HEADLESS"] = "1"
    agent = Session(session_id, artifact_dir, allowed)
    boot = outbox / "_boot.json"
    boot.write_text(json.dumps({"runtime":"github-actions", "session":session_id,
                                "run_id":os.getenv("GITHUB_RUN_ID"), "started":time.time(),
                                "allowed_hosts":allowed}), encoding="utf-8")
    publish([boot], f"remote: start {session_id}")
    started = last_action = time.monotonic()
    try:
        while not stop_signal and time.monotonic()-started < duration and time.monotonic()-last_action < idle:
            pull = git("pull", "--ff-only", "origin", "main", check=False)
            if pull.returncode != 0:
                time.sleep(3)
                continue
            for path in sorted(inbox.glob("*.json")):
                if stop_signal:
                    break
                result_path = outbox / path.name
                if result_path.exists():
                    continue
                try:
                    cmd = json.loads(path.read_text(encoding="utf-8"))
                    if not isinstance(cmd, dict) or cmd.get("session") != session_id:
                        raise ValueError("Session mismatch")
                    if cmd.get("id") != path.stem or not SESSION_RE.fullmatch(path.stem):
                        raise ValueError("Command ID mismatch")
                    data, stop = agent.execute(cmd)
                    result = {"id":cmd["id"], "ok":True, "action":cmd["action"],
                              "data":data, "time":time.time(), "session":session_id}
                except Exception as exc:
                    stop = False
                    result = {"id":path.stem, "ok":False, "error":f"{type(exc).__name__}: {exc}",
                              "time":time.time(), "session":session_id}
                    agent.event({"event":"command_error", **result})
                result_path.write_text(json.dumps(scrub(result), ensure_ascii=False), encoding="utf-8")
                publish([result_path], f"remote: {session_id}/{path.stem}")
                last_action = time.monotonic()
                if stop:
                    stop_signal = True
                    break
            time.sleep(2)
    finally:
        agent.close()
    print(f"Firetrace remote session {session_id} ended; sanitized artifacts saved.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
