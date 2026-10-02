import base64
import json

from firetrace.local_mcp import LocalMcpBridge, SERVER_NAME, tool_specs


class FakeBackend:
    def __init__(self):
        self.opened = None
        self.recording = False

    def status(self):
        return {"backend": "fake", "connected": True, "url": "https://example.test"}

    def open(self, url):
        self.opened = url
        return {"url": url}

    def click(self, x, y):
        return {"x": x, "y": y}

    def click_relative(self, rx, ry):
        return {"rx": rx, "ry": ry}

    def wait(self, ms):
        return {"waited_ms": ms}

    def screenshot(self, quality=65):
        return b"jpeg-bytes"

    def network_events(self):
        return {"events": []}

    def network_clear(self):
        return {"cleared": True}

    def trigger_and_capture(self, **args):
        return {"filter": args.get("url_contains", ""), "captures": []}

    def record_start(self):
        self.recording = True
        return {"recording": True}

    def record_status(self):
        return {"recording": self.recording}

    def record_save(self):
        self.recording = False
        return {"ok": True, "path": "capture.har"}


def test_initialize_and_tool_listing():
    bridge = LocalMcpBridge(FakeBackend(), port=0)

    initialized = bridge.handle_rpc(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        }
    )
    assert initialized["result"]["serverInfo"]["name"] == SERVER_NAME

    listed = bridge.handle_rpc(
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
    )
    names = {tool["name"] for tool in listed["result"]["tools"]}
    assert {
        "browser_status",
        "browser_open",
        "browser_screenshot",
        "trigger_and_capture",
        "record_start",
        "record_status",
        "record_save",
    } <= names


def test_tool_calls_and_screenshot_content():
    backend = FakeBackend()
    bridge = LocalMcpBridge(backend, port=0)

    opened = bridge.handle_rpc(
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "browser_open",
                "arguments": {"url": "https://example.test/game"},
            },
        }
    )
    payload = json.loads(opened["result"]["content"][0]["text"])
    assert payload["url"] == "https://example.test/game"
    assert backend.opened == "https://example.test/game"

    screenshot = bridge.handle_rpc(
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {"name": "browser_screenshot", "arguments": {"quality": 70}},
        }
    )
    image = screenshot["result"]["content"][0]
    assert image["type"] == "image"
    assert base64.b64decode(image["data"]) == b"jpeg-bytes"


def test_recording_tools_are_callable():
    backend = FakeBackend()
    bridge = LocalMcpBridge(backend, port=0)

    for request_id, name in enumerate(
        ("record_start", "record_status", "record_save"), start=10
    ):
        result = bridge.handle_rpc(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "tools/call",
                "params": {"name": name, "arguments": {}},
            }
        )
        assert result["result"].get("isError") is not True


def test_tool_specs_have_unique_names():
    names = [tool["name"] for tool in tool_specs()]
    assert len(names) == len(set(names))
