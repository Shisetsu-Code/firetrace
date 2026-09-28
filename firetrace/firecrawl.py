from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from .redact import redact_capture


class FirecrawlError(RuntimeError):
    pass


@dataclass
class FirecrawlClient:
    base_url: str = "http://127.0.0.1:3002"
    api_key: str | None = None
    timeout: float = 30.0

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        url = self.base_url.rstrip("/") + path
        payload = None if body is None else json.dumps(body).encode()
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        req = urllib.request.Request(url, data=payload, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                raw = res.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            raise FirecrawlError(f"{method} {path} -> HTTP {e.code}: {detail}") from e
        except OSError as e:
            raise FirecrawlError(f"{method} {path} failed: {e}") from e
        if not raw:
            return {}
        data = json.loads(raw.decode("utf-8"))
        if data.get("success") is False:
            raise FirecrawlError(data.get("error") or f"{method} {path} failed")
        return data

    def health(self) -> bool:
        for path in ("/", "/health"):
            try:
                req = urllib.request.Request(self.base_url.rstrip("/") + path, method="GET")
                with urllib.request.urlopen(req, timeout=2) as res:
                    if 200 <= res.status < 500:
                        return True
            except Exception:
                pass
        return False

    def create_browser(self, ttl: int = 900) -> str:
        data = self._request("POST", "/v2/browser", {"ttl": ttl, "streamWebView": True})
        session_id = data.get("id")
        if not session_id:
            raise FirecrawlError(f"Browser session id missing: {data}")
        return session_id

    def browser_status(self, session_id: str) -> dict:
        return self._request("GET", f"/v2/browser/{session_id}")

    def execute(self, session_id: str, code: str, timeout: int = 30) -> dict:
        return self._request(
            "POST",
            f"/v2/browser/{session_id}/execute",
            {"code": code, "language": "node", "timeout": timeout},
        )

    def stop(self, session_id: str) -> dict:
        return self._request("DELETE", f"/v2/browser/{session_id}")


class FirecrawlBackend:
    def __init__(self, client: FirecrawlClient):
        self.client = client
        self.session_id: str | None = None

    def ensure_session(self) -> str:
        if self.session_id:
            try:
                status = self.client.browser_status(self.session_id)
                if status.get("status") not in {"destroyed", "error"}:
                    return self.session_id
            except Exception:
                pass
        self.session_id = self.client.create_browser()
        return self.session_id

    def _exec(self, code: str, timeout: int = 30) -> dict:
        sid = self.ensure_session()
        result = self.client.execute(sid, code, timeout=timeout)
        if result.get("exitCode", 0) != 0 or result.get("killed"):
            raise FirecrawlError(result.get("stderr") or result.get("error") or "browser execution failed")
        return result

    @staticmethod
    def _stdout(result: dict) -> str:
        return str(result.get("stdout") or result.get("result") or "").strip()

    def status(self) -> dict:
        sid = self.ensure_session()
        data = self.client.browser_status(sid)
        return {"backend": "firecrawl", "session_id": sid, **data}

    def open(self, url: str) -> dict:
        code = f"await page.goto({json.dumps(url)}, {{waitUntil:'domcontentloaded'}}); console.log(page.url());"
        out = self._stdout(self._exec(code, 60))
        return {"url": out.splitlines()[-1] if out else url}

    def wait(self, ms: int) -> dict:
        self._exec(f"await page.waitForTimeout({int(ms)}); console.log('ok');", max(5, int(ms / 1000) + 5))
        return {"waited_ms": int(ms)}

    def click(self, x: float, y: float) -> dict:
        self._exec(f"await page.mouse.click({float(x)}, {float(y)}); console.log('ok');")
        return {"x": x, "y": y}

    def click_relative(self, rx: float, ry: float) -> dict:
        code = f"""
const v = page.viewportSize() || {{width: await page.evaluate(()=>innerWidth), height: await page.evaluate(()=>innerHeight)}};
const x = v.width * {float(rx)};
const y = v.height * {float(ry)};
await page.mouse.click(x,y);
console.log(JSON.stringify({{x,y,width:v.width,height:v.height}}));
"""
        out = self._stdout(self._exec(code))
        return json.loads(out.splitlines()[-1])

    def screenshot(self, quality: int = 60) -> bytes:
        code = f"console.log(await page.screenshot({{type:'jpeg',quality:{int(quality)},encoding:'base64'}}));"
        out = self._stdout(self._exec(code, 30))
        if not out:
            raise FirecrawlError("empty screenshot")
        return base64.b64decode(out.splitlines()[-1])

    def network_clear(self) -> dict:
        # Capture is intentionally per-operation. There is no hidden event backlog.
        return {"cleared": True}

    def network_events(self) -> dict:
        return {"events": [], "note": "Firecrawl backend captures network events atomically via trigger_and_capture"}

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
        if x is None or y is None:
            if rx is None or ry is None:
                raise ValueError("provide x/y or rx/ry")
            click_js = f"""
const v = page.viewportSize() || {{width: await page.evaluate(()=>innerWidth), height: await page.evaluate(()=>innerHeight)}};
await page.mouse.click(v.width * {float(rx)}, v.height * {float(ry)});
"""
        else:
            click_js = f"await page.mouse.click({float(x)}, {float(y)});"

        marker = "__FIRETRACE__"
        code = f"""
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
const filter = {json.dumps(url_contains)};
const requests = new Map();
const responses = new Map();

cdp.on('Network.requestWillBeSent', e => {{
  if (e.request && e.request.url && e.request.url.includes(filter)) {{
    requests.set(e.requestId, {{
      requestId: e.requestId,
      timestamp: e.timestamp,
      url: e.request.url,
      method: e.request.method,
      headers: e.request.headers || {{}},
      postData: e.request.postData ?? null
    }});
  }}
}});

cdp.on('Network.responseReceived', e => {{
  if (e.response && e.response.url && e.response.url.includes(filter)) {{
    responses.set(e.requestId, {{
      requestId: e.requestId,
      timestamp: e.timestamp,
      url: e.response.url,
      status: e.response.status,
      responseHeaders: e.response.headers || {{}}
    }});
  }}
}});

{click_js}
await page.waitForTimeout({int(wait_ms)});

const captures = [];
for (const [requestId, req] of requests.entries()) {{
  const resp = responses.get(requestId) || {{}};
  let responseBody = null;
  let base64Encoded = false;
  let bodyError = null;
  if (responses.has(requestId)) {{
    try {{
      const body = await cdp.send('Network.getResponseBody', {{requestId}});
      responseBody = body.body;
      base64Encoded = !!body.base64Encoded;
    }} catch (e) {{
      bodyError = String(e);
    }}
  }}
  captures.push({{...req, ...resp, responseBody, base64Encoded, bodyError}});
}}
await cdp.detach();
console.log({json.dumps(marker)} + JSON.stringify({{captures}}));
"""
        out = self._stdout(self._exec(code, max(30, int(wait_ms / 1000) + 15)))
        line = next((ln for ln in reversed(out.splitlines()) if ln.startswith(marker)), None)
        if line is None:
            raise FirecrawlError(f"capture marker missing: {out[-500:]}")
        payload = json.loads(line[len(marker):])
        payload["captures"] = [redact_capture(c) for c in payload.get("captures", [])]
        payload["filter"] = url_contains
        return payload
