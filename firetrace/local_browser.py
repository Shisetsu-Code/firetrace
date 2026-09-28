from __future__ import annotations

import json
import os
from typing import Any

from .redact import redact_capture


class LocalBrowserBackend:
    """Local Playwright/CDP backend.

    It first tries to attach to Chrome on 127.0.0.1:9222. If unavailable it
    launches a local Chromium instance. Nothing is exposed outside localhost.
    """

    def __init__(self, cdp_url: str = "http://127.0.0.1:9222"):
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        self._owns_browser = False
        try:
            self.browser = self._pw.chromium.connect_over_cdp(cdp_url)
        except Exception:
            self.browser = self._pw.chromium.launch(headless=os.getenv("FIRETRACE_HEADLESS", "0") == "1")
            self._owns_browser = True

        contexts = self.browser.contexts
        self.context = contexts[0] if contexts else self.browser.new_context()
        pages = self.context.pages
        self.page = pages[0] if pages else self.context.new_page()

    def close(self) -> None:
        try:
            if self._owns_browser:
                self.browser.close()
        finally:
            self._pw.stop()

    def status(self) -> dict:
        return {
            "backend": "local-playwright-cdp",
            "connected": self.browser.is_connected(),
            "url": self.page.url,
            "pages": len(self.context.pages),
            "viewport": self.page.viewport_size,
        }

    def open(self, url: str) -> dict:
        self.page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        return {"url": self.page.url}

    def wait(self, ms: int) -> dict:
        self.page.wait_for_timeout(int(ms))
        return {"waited_ms": int(ms)}

    def click(self, x: float, y: float) -> dict:
        self.page.mouse.click(float(x), float(y))
        return {"x": x, "y": y}

    def click_relative(self, rx: float, ry: float) -> dict:
        size = self.page.viewport_size
        if not size:
            size = self.page.evaluate("() => ({width: innerWidth, height: innerHeight})")
        x = size["width"] * float(rx)
        y = size["height"] * float(ry)
        self.page.mouse.click(x, y)
        return {"x": x, "y": y, "width": size["width"], "height": size["height"]}

    def screenshot(self, quality: int = 60) -> bytes:
        return self.page.screenshot(type="jpeg", quality=int(quality))

    def network_clear(self) -> dict:
        return {"cleared": True}

    def network_events(self) -> dict:
        return {
            "events": [],
            "note": "Network capture is atomic through trigger_and_capture.",
        }

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

            self.page.wait_for_timeout(int(wait_ms))
            captures = []
            for request_id, req in requests.items():
                item = {**req, **responses.get(request_id, {})}
                item["responseBody"] = None
                item["base64Encoded"] = False
                item["bodyError"] = None
                if request_id in responses:
                    try:
                        body = cdp.send("Network.getResponseBody", {"requestId": request_id})
                        item["responseBody"] = body.get("body")
                        item["base64Encoded"] = bool(body.get("base64Encoded"))
                    except Exception as exc:
                        item["bodyError"] = str(exc)
                captures.append(redact_capture(item))
            return {"filter": url_contains, "captures": captures}
        finally:
            cdp.detach()
