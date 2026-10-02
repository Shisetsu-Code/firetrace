from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .redact import redact_capture, redact_headers


def _headers_to_har(headers: dict | None) -> list[dict[str, str]]:
    clean = redact_headers(headers or {})
    return [{"name": str(key), "value": str(value)} for key, value in clean.items()]


class LocalBrowserBackend:
    """Local Playwright/CDP backend.

    Firetrace first attaches to Chrome on 127.0.0.1:9222. If unavailable it
    launches Playwright Chromium. Nothing is exposed outside localhost.
    """

    def __init__(self, cdp_url: str = "http://127.0.0.1:9222"):
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        self._owns_browser = False
        self._last_capture: list[dict[str, Any]] = []
        self._recording: dict[str, Any] | None = None

        try:
            self.browser = self._pw.chromium.connect_over_cdp(cdp_url)
        except Exception:
            self.browser = self._pw.chromium.launch(
                headless=os.getenv("FIRETRACE_HEADLESS", "0") == "1"
            )
            self._owns_browser = True

        contexts = self.browser.contexts
        self.context = contexts[0] if contexts else self.browser.new_context()
        pages = self.context.pages
        self.page = pages[0] if pages else self.context.new_page()

    def close(self) -> None:
        try:
            if self._recording:
                try:
                    self._recording["cdp"].detach()
                except Exception:
                    pass
                self._recording = None
            if self._owns_browser:
                self.browser.close()
        finally:
            self._pw.stop()

    def status(self) -> dict:
        return {
            "backend": "local-playwright-cdp",
            "connected": self.browser.is_connected(),
            "url": self.page.url,
            "title": self.page.title(),
            "pages": len(self.context.pages),
            "viewport": self.page.viewport_size,
            "recording": bool(self._recording),
        }

    def open(self, url: str) -> dict:
        self.page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        return {"url": self.page.url, "title": self.page.title()}

    def wait(self, ms: int) -> dict:
        value = max(0, min(int(ms), 60_000))
        self.page.wait_for_timeout(value)
        return {"waited_ms": value}

    def click(self, x: float, y: float) -> dict:
        self.page.mouse.click(float(x), float(y))
        return {"x": float(x), "y": float(y)}

    def click_relative(self, rx: float, ry: float) -> dict:
        nrx = float(rx)
        nry = float(ry)
        if not (0 <= nrx <= 1 and 0 <= nry <= 1):
            raise ValueError("rx and ry must be between 0 and 1")
        size = self.page.viewport_size
        if not size:
            size = self.page.evaluate("() => ({width: innerWidth, height: innerHeight})")
        x = size["width"] * nrx
        y = size["height"] * nry
        self.page.mouse.click(x, y)
        return {"x": x, "y": y, "width": size["width"], "height": size["height"]}

    def screenshot(self, quality: int = 60) -> bytes:
        quality = max(20, min(int(quality), 90))
        return self.page.screenshot(type="jpeg", quality=quality)

    def network_clear(self) -> dict:
        self._last_capture = []
        return {"cleared": True}

    def network_events(self) -> dict:
        return {"events": self._last_capture}

    def trigger_and_capture(
        self,
        *,
        url_contains: str = "fn=play",
        x: float | None = None,
        y: float | None = None,
        rx: float | None = None,
        ry: float | None = None,
        wait_ms: int = 2500,
    ) -> dict:
        cdp = self.context.new_cdp_session(self.page)
        cdp.send("Network.enable")
        requests: dict[str, dict[str, Any]] = {}
        responses: dict[str, dict[str, Any]] = {}

        def on_request(event: dict) -> None:
            req = event.get("request") or {}
            url = req.get("url") or ""
            if url_contains in url:
                requests[event["requestId"]] = {
                    "requestId": event["requestId"],
                    "timestamp": event.get("timestamp"),
                    "url": url,
                    "method": req.get("method"),
                    "headers": req.get("headers") or {},
                    "postData": req.get("postData"),
                }

        def on_response(event: dict) -> None:
            resp = event.get("response") or {}
            url = resp.get("url") or ""
            if url_contains in url:
                responses[event["requestId"]] = {
                    "requestId": event["requestId"],
                    "timestamp": event.get("timestamp"),
                    "url": url,
                    "status": resp.get("status"),
                    "responseHeaders": resp.get("headers") or {},
                }

        cdp.on("Network.requestWillBeSent", on_request)
        cdp.on("Network.responseReceived", on_response)

        try:
            if x is not None and y is not None:
                self.page.mouse.click(float(x), float(y))
            elif rx is not None and ry is not None:
                self.click_relative(float(rx), float(ry))
            else:
                raise ValueError("provide x/y or rx/ry")

            self.page.wait_for_timeout(max(0, min(int(wait_ms), 30_000)))
            captures = []
            for request_id, req in requests.items():
                item = {**req, **responses.get(request_id, {})}
                item["responseBody"] = None
                item["base64Encoded"] = False
                item["bodyError"] = None
                if request_id in responses:
                    try:
                        body = cdp.send(
                            "Network.getResponseBody", {"requestId": request_id}
                        )
                        item["responseBody"] = body.get("body")
                        item["base64Encoded"] = bool(body.get("base64Encoded"))
                    except Exception as exc:
                        item["bodyError"] = str(exc)
                captures.append(redact_capture(item))
            self._last_capture = captures
            return {"filter": url_contains, "captures": captures}
        finally:
            cdp.detach()

    def record_start(self) -> dict:
        if self._recording:
            return self.record_status()

        cdp = self.context.new_cdp_session(self.page)
        cdp.send("Network.enable", {"maxTotalBufferSize": 100_000_000})

        state: dict[str, Any] = {
            "cdp": cdp,
            "started_wall": time.time(),
            "started_iso": datetime.now(timezone.utc).isoformat(),
            "requests": {},
            "responses": {},
            "websockets": {},
            "frames": {},
        }

        def on_request(event: dict) -> None:
            request_id = event.get("requestId")
            req = event.get("request") or {}
            if not request_id:
                return
            state["requests"][request_id] = {
                "requestId": request_id,
                "timestamp": event.get("timestamp"),
                "url": req.get("url") or "",
                "method": req.get("method") or "GET",
                "headers": req.get("headers") or {},
                "postData": req.get("postData"),
            }

        def on_response(event: dict) -> None:
            request_id = event.get("requestId")
            resp = event.get("response") or {}
            if not request_id:
                return
            state["responses"][request_id] = {
                "status": int(resp.get("status") or 0),
                "statusText": resp.get("statusText") or "",
                "headers": resp.get("headers") or {},
                "mimeType": resp.get("mimeType") or "",
                "protocol": resp.get("protocol") or "",
            }

        def on_ws_created(event: dict) -> None:
            request_id = event.get("requestId")
            if not request_id:
                return
            state["websockets"][request_id] = event.get("url") or ""
            state["frames"].setdefault(request_id, [])

        def add_ws_frame(direction: str, event: dict) -> None:
            request_id = event.get("requestId")
            response = event.get("response") or {}
            if not request_id:
                return
            state["frames"].setdefault(request_id, []).append(
                {
                    "direction": direction,
                    "timestamp": event.get("timestamp"),
                    "opcode": response.get("opcode"),
                    "payloadData": response.get("payloadData"),
                }
            )

        cdp.on("Network.requestWillBeSent", on_request)
        cdp.on("Network.responseReceived", on_response)
        cdp.on("Network.webSocketCreated", on_ws_created)
        cdp.on(
            "Network.webSocketFrameSent",
            lambda event: add_ws_frame("sent", event),
        )
        cdp.on(
            "Network.webSocketFrameReceived",
            lambda event: add_ws_frame("received", event),
        )

        self._recording = state
        return self.record_status()

    def record_status(self) -> dict:
        if not self._recording:
            return {
                "recording": False,
                "elapsed_ms": 0,
                "requests": 0,
                "responses": 0,
                "ws_frames": 0,
            }

        state = self._recording
        frames = sum(len(items) for items in state["frames"].values())
        return {
            "recording": True,
            "elapsed_ms": int((time.time() - state["started_wall"]) * 1000),
            "requests": len(state["requests"]),
            "responses": len(state["responses"]),
            "ws_frames": frames,
            "url": self.page.url,
        }

    def _har_entry(
        self,
        request_id: str,
        request: dict[str, Any],
        response: dict[str, Any] | None,
        body: dict[str, Any] | None,
        frames: list[dict[str, Any]],
        started_iso: str,
    ) -> dict[str, Any]:
        url = request.get("url") or ""
        method = request.get("method") or "GET"
        post_data = request.get("postData")
        response = response or {}
        body = body or {}

        request_har: dict[str, Any] = {
            "method": method,
            "url": url,
            "httpVersion": "HTTP/1.1",
            "headers": _headers_to_har(request.get("headers")),
            "queryString": [],
            "cookies": [],
            "headersSize": -1,
            "bodySize": len(post_data.encode("utf-8")) if isinstance(post_data, str) else 0,
        }
        if post_data is not None:
            request_har["postData"] = {
                "mimeType": str((request.get("headers") or {}).get("content-type", "")),
                "text": post_data,
            }

        response_text = body.get("body")
        encoding = "base64" if body.get("base64Encoded") else None
        content: dict[str, Any] = {
            "size": len(response_text.encode("utf-8")) if isinstance(response_text, str) else 0,
            "mimeType": response.get("mimeType") or "",
            "text": response_text if response_text is not None else "",
        }
        if encoding:
            content["encoding"] = encoding
        if body.get("error"):
            content["_bodyCaptureError"] = body["error"]

        entry: dict[str, Any] = {
            "startedDateTime": started_iso,
            "time": 0,
            "request": request_har,
            "response": {
                "status": response.get("status", 0),
                "statusText": response.get("statusText", ""),
                "httpVersion": response.get("protocol") or "HTTP/1.1",
                "headers": _headers_to_har(response.get("headers")),
                "cookies": [],
                "content": content,
                "redirectURL": "",
                "headersSize": -1,
                "bodySize": content["size"],
            },
            "cache": {},
            "timings": {
                "blocked": -1,
                "dns": -1,
                "connect": -1,
                "send": 0,
                "wait": 0,
                "receive": 0,
                "ssl": -1,
            },
            "_requestId": request_id,
        }
        if frames:
            entry["_webSocketFrames"] = frames
        return entry

    def record_save(self) -> dict:
        if not self._recording:
            raise RuntimeError("No active HAR recording")

        state = self._recording
        cdp = state["cdp"]
        try:
            self.page.wait_for_timeout(50)
            entries = []
            request_ids = set(state["requests"]) | set(state["websockets"])
            for request_id in request_ids:
                request = state["requests"].get(request_id)
                if request is None:
                    request = {
                        "requestId": request_id,
                        "url": state["websockets"].get(request_id) or "",
                        "method": "GET",
                        "headers": {},
                        "postData": None,
                    }

                body: dict[str, Any] = {}
                if request_id in state["responses"]:
                    try:
                        body = cdp.send(
                            "Network.getResponseBody", {"requestId": request_id}
                        )
                    except Exception as exc:
                        body = {"body": "", "base64Encoded": False, "error": str(exc)}

                entries.append(
                    self._har_entry(
                        request_id,
                        request,
                        state["responses"].get(request_id),
                        body,
                        state["frames"].get(request_id, []),
                        state["started_iso"],
                    )
                )

            har = {
                "log": {
                    "version": "1.2",
                    "creator": {"name": "Firetrace", "version": "0.3.0"},
                    "pages": [],
                    "entries": entries,
                }
            }

            output_dir = Path.home() / "Downloads" / "Firetrace-HARs"
            output_dir.mkdir(parents=True, exist_ok=True)
            host = urlparse(self.page.url).hostname or "capture"
            safe_host = "".join(
                ch if ch.isalnum() or ch in ".-_" else "_" for ch in host
            )
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            path = output_dir / f"{safe_host}-{stamp}.har"
            payload = json.dumps(har, indent=2, ensure_ascii=False)
            path.write_text(payload, encoding="utf-8")

            frames = sum(len(items) for items in state["frames"].values())
            return {
                "ok": True,
                "path": str(path),
                "entries": len(entries),
                "ws_frames": frames,
                "bytes": len(payload.encode("utf-8")),
            }
        finally:
            try:
                cdp.detach()
            finally:
                self._recording = None
