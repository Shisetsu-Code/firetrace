import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from firetrace.local_browser import LocalBrowserBackend


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == "/":
            body = b"""<!doctype html><button id='buy'>BUY</button>
<script>
document.getElementById('buy').onclick = async () => {
  const r = await fetch('/game.web/service?fn=play', {
    method: 'POST',
    headers: {'Content-Type':'application/x-www-form-urlencoded'},
    body: 'cmd=TEST&amount=1'
  });
  window.answer = await r.json();
};
</script>"""
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def do_POST(self):
        if self.path.startswith("/game.web/service?fn=play"):
            length = int(self.headers.get("Content-Length", "0"))
            self.rfile.read(length)
            payload = json.dumps({"ok": True, "feature": "TEST"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Set-Cookie", "secret=test")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_error(404)


@pytest.fixture()
def server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd.server_address[1]
    finally:
        httpd.shutdown()
        thread.join(timeout=2)


def test_trigger_and_capture_end_to_end(server):
    os.environ["FIRETRACE_HEADLESS"] = "1"
    browser = LocalBrowserBackend("http://127.0.0.1:1")
    try:
        browser.open(f"http://127.0.0.1:{server}/")
        box = browser.page.locator("#buy").bounding_box()
        assert box
        result = browser.trigger_and_capture(
            x=box["x"] + box["width"] / 2,
            y=box["y"] + box["height"] / 2,
            url_contains="fn=play",
            wait_ms=750,
        )
        assert len(result["captures"]) == 1
        capture = result["captures"][0]
        assert capture["method"] == "POST"
        assert capture["postData"] == "cmd=TEST&amount=1"
        assert capture["status"] == 200
        assert json.loads(capture["responseBody"])["feature"] == "TEST"
        # CDP header casing varies, but cookie material must be redacted.
        for key, value in capture["responseHeaders"].items():
            if key.lower() == "set-cookie":
                assert value == "[REDACTED]"
    finally:
        browser.close()
