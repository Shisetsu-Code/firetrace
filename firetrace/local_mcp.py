from __future__ import annotations

import base64
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

SERVER_NAME = "Firetrace"
SERVER_VERSION = "0.3.0"
DEFAULT_PROTOCOL_VERSION = "2025-03-26"


def _annotations(read_only: bool) -> dict[str, bool]:
    return {
        "readOnlyHint": read_only,
        "destructiveHint": not read_only,
        "idempotentHint": read_only,
        "openWorldHint": True,
    }


def tool_specs() -> list[dict[str, Any]]:
    empty = {"type": "object", "properties": {}, "additionalProperties": False}
    return [
        {
            "name": "browser_status",
            "description": "Read the current Firetrace browser state.",
            "inputSchema": empty,
            "annotations": _annotations(True),
        },
        {
            "name": "browser_open",
            "description": "Open an HTTP or HTTPS URL in the Firetrace browser.",
            "inputSchema": {
                "type": "object",
                "properties": {"url": {"type": "string", "format": "uri"}},
                "required": ["url"],
                "additionalProperties": False,
            },
            "annotations": _annotations(False),
        },
        {
            "name": "browser_click",
            "description": "Click absolute viewport pixel coordinates.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "x": {"type": "number", "minimum": 0},
                    "y": {"type": "number", "minimum": 0},
                },
                "required": ["x", "y"],
                "additionalProperties": False,
            },
            "annotations": _annotations(False),
        },
        {
            "name": "browser_click_relative",
            "description": "Click normalized viewport coordinates between 0 and 1.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "rx": {"type": "number", "minimum": 0, "maximum": 1},
                    "ry": {"type": "number", "minimum": 0, "maximum": 1},
                },
                "required": ["rx", "ry"],
                "additionalProperties": False,
            },
            "annotations": _annotations(False),
        },
        {
            "name": "browser_wait",
            "description": "Wait for the current page to settle.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ms": {"type": "integer", "minimum": 0, "maximum": 60000, "default": 1000}
                },
                "additionalProperties": False,
            },
            "annotations": _annotations(False),
        },
        {
            "name": "browser_screenshot",
            "description": "Capture the current Firetrace viewport as JPEG.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "quality": {"type": "integer", "minimum": 20, "maximum": 90, "default": 65}
                },
                "additionalProperties": False,
            },
            "annotations": _annotations(True),
        },
        {
            "name": "network_events",
            "description": "Read the most recent atomic network capture.",
            "inputSchema": empty,
            "annotations": _annotations(True),
        },
        {
            "name": "network_clear",
            "description": "Clear the most recent atomic network capture.",
            "inputSchema": empty,
            "annotations": _annotations(False),
        },
        {
            "name": "trigger_and_capture",
            "description": "Click once and capture matching HTTP request/response traffic.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url_contains": {"type": "string", "default": "fn=play"},
                    "x": {"type": "number", "minimum": 0},
                    "y": {"type": "number", "minimum": 0},
                    "rx": {"type": "number", "minimum": 0, "maximum": 1},
                    "ry": {"type": "number", "minimum": 0, "maximum": 1},
                    "wait_ms": {"type": "integer", "minimum": 0, "maximum": 30000, "default": 2500},
                },
                "additionalProperties": False,
            },
            "annotations": _annotations(False),
        },
        {
            "name": "record_start",
            "description": "Start a full HAR recording in the current Firetrace browser without reloading.",
            "inputSchema": empty,
            "annotations": _annotations(False),
        },
        {
            "name": "record_status",
            "description": "Read the status and counters of the current HAR recording.",
            "inputSchema": empty,
            "annotations": _annotations(True),
        },
        {
            "name": "record_save",
            "description": "Stop the current HAR recording and save it under Downloads/Firetrace-HARs.",
            "inputSchema": empty,
            "annotations": _annotations(False),
        },
        {
            "name": "sequence",
            "description": "Run a short ordered sequence of Firetrace browser actions.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "maxItems": 50,
                        "items": {
                            "type": "object",
                            "properties": {
                                "action": {"type": "string"},
                                "args": {"type": "object"},
                            },
                            "required": ["action"],
                            "additionalProperties": False,
                        },
                    }
                },
                "required": ["steps"],
                "additionalProperties": False,
            },
            "annotations": _annotations(False),
        },
    ]


class LocalMcpBridge:
    def __init__(self, backend, host: str = "127.0.0.1", port: int = 8765):
        self.backend = backend
        self.host = host
        self.port = int(port)
        self.httpd: HTTPServer | None = None

    @property
    def endpoint(self) -> str:
        return f"http://{self.host}:{self.port}/mcp"

    @property
    def health_url(self) -> str:
        return f"http://{self.host}:{self.port}/health"

    def _text(self, value: Any, *, is_error: bool = False) -> dict[str, Any]:
        result: dict[str, Any] = {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(value, ensure_ascii=False, separators=(",", ":")),
                }
            ]
        }
        if is_error:
            result["isError"] = True
        return result

    def _tool_call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        try:
            if name == "browser_status":
                return self._text(self.backend.status())
            if name == "browser_open":
                url = str(args["url"])
                if not url.startswith(("http://", "https://")):
                    raise ValueError("HTTP(S) URL required")
                return self._text(self.backend.open(url))
            if name == "browser_click":
                return self._text(self.backend.click(args["x"], args["y"]))
            if name == "browser_click_relative":
                return self._text(self.backend.click_relative(args["rx"], args["ry"]))
            if name == "browser_wait":
                return self._text(self.backend.wait(int(args.get("ms", 1000))))
            if name == "browser_screenshot":
                quality = max(20, min(int(args.get("quality", 65)), 90))
                data = self.backend.screenshot(quality)
                return {
                    "content": [
                        {
                            "type": "image",
                            "mimeType": "image/jpeg",
                            "data": base64.b64encode(data).decode("ascii"),
                        }
                    ]
                }
            if name == "network_events":
                return self._text(self.backend.network_events())
            if name == "network_clear":
                return self._text(self.backend.network_clear())
            if name == "trigger_and_capture":
                return self._text(self.backend.trigger_and_capture(**args))
            if name == "record_start":
                return self._text(self.backend.record_start())
            if name == "record_status":
                return self._text(self.backend.record_status())
            if name == "record_save":
                return self._text(self.backend.record_save())
            if name == "sequence":
                return self._text(self._sequence(args.get("steps") or []))
            raise ValueError(f"unknown tool: {name}")
        except Exception as exc:
            return self._text({"error": f"{type(exc).__name__}: {exc}"}, is_error=True)

    def _sequence(self, steps: list[dict[str, Any]]) -> dict[str, Any]:
        if not isinstance(steps, list) or len(steps) > 50:
            raise ValueError("sequence.steps must contain at most 50 items")
        results = []
        for index, step in enumerate(steps):
            if not isinstance(step, dict):
                raise ValueError(f"invalid sequence step {index}")
            action = str(step.get("action") or "")
            args = step.get("args") or {}
            if action == "status":
                data = self.backend.status()
            elif action == "open":
                data = self.backend.open(args["url"])
            elif action == "wait":
                data = self.backend.wait(int(args.get("ms", 500)))
            elif action == "click":
                data = self.backend.click(args["x"], args["y"])
            elif action == "click_relative":
                data = self.backend.click_relative(args["rx"], args["ry"])
            elif action == "trigger_and_capture":
                data = self.backend.trigger_and_capture(**args)
            elif action == "record_start":
                data = self.backend.record_start()
            elif action == "record_status":
                data = self.backend.record_status()
            elif action == "record_save":
                data = self.backend.record_save()
            else:
                raise ValueError(f"unsupported sequence action: {action}")
            results.append({"index": index, "action": action, "data": data})
        return {"steps": results}

    def handle_rpc(self, request: dict[str, Any]) -> dict[str, Any] | None:
        method = request.get("method")
        request_id = request.get("id")
        params = request.get("params") or {}

        if request_id is None:
            return None

        if method == "initialize":
            requested = params.get("protocolVersion")
            protocol = requested if isinstance(requested, str) and requested else DEFAULT_PROTOCOL_VERSION
            result = {
                "protocolVersion": protocol,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "instructions": (
                    "Control the local Firetrace browser. Use browser_status before acting when "
                    "the current page is uncertain. Use record_start/record_save for full HAR sessions."
                ),
            }
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": tool_specs()}
        elif method == "tools/call":
            name = str(params.get("name") or "")
            args = params.get("arguments") or {}
            if not isinstance(args, dict):
                args = {}
            result = self._tool_call(name, args)
        else:
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"},
            }

        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    def _handler_class(self):
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "FiretraceMCP/0.3"

            def log_message(self, *_args):
                pass

            def _cors(self) -> None:
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
                self.send_header(
                    "Access-Control-Allow-Headers",
                    "content-type, accept, mcp-session-id, mcp-protocol-version",
                )

            def _json(self, status: int, value: Any) -> None:
                payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self._cors()
                self.end_headers()
                self.wfile.write(payload)

            def do_OPTIONS(self):
                self.send_response(204)
                self._cors()
                self.end_headers()

            def do_GET(self):
                if self.path.split("?", 1)[0] == "/health":
                    self._json(
                        200,
                        {
                            "ok": True,
                            "service": "firetrace-local-mcp",
                            "name": SERVER_NAME,
                            "version": SERVER_VERSION,
                            "endpoint": bridge.endpoint,
                        },
                    )
                    return
                self._json(404, {"error": "not found"})

            def do_POST(self):
                if self.path.split("?", 1)[0] != "/mcp":
                    self._json(404, {"error": "not found"})
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0") or 0)
                    body = self.rfile.read(length)
                    parsed = json.loads(body.decode("utf-8")) if body else {}
                except Exception as exc:
                    self._json(
                        400,
                        {
                            "jsonrpc": "2.0",
                            "id": None,
                            "error": {"code": -32700, "message": f"Parse error: {exc}"},
                        },
                    )
                    return

                if isinstance(parsed, list):
                    responses = [
                        response
                        for item in parsed
                        if isinstance(item, dict)
                        for response in [bridge.handle_rpc(item)]
                        if response is not None
                    ]
                    if not responses:
                        self.send_response(202)
                        self._cors()
                        self.end_headers()
                    else:
                        self._json(200, responses)
                    return

                if not isinstance(parsed, dict):
                    self._json(
                        400,
                        {
                            "jsonrpc": "2.0",
                            "id": None,
                            "error": {"code": -32600, "message": "Invalid Request"},
                        },
                    )
                    return

                response = bridge.handle_rpc(parsed)
                if response is None:
                    self.send_response(202)
                    self._cors()
                    self.end_headers()
                else:
                    self._json(200, response)

        return Handler

    def run(self, stop_event: threading.Event | None = None) -> None:
        stop_event = stop_event or threading.Event()
        self.httpd = HTTPServer((self.host, self.port), self._handler_class())
        self.httpd.timeout = 0.25
        print(f"Firetrace local MCP listening: {self.endpoint}")
        print(f"Health: {self.health_url}")
        try:
            while not stop_event.is_set():
                self.httpd.handle_request()
        finally:
            self.httpd.server_close()
            self.httpd = None


def bridge_from_environment(backend) -> LocalMcpBridge:
    host = os.getenv("FIRETRACE_MCP_HOST", "127.0.0.1")
    port = int(os.getenv("FIRETRACE_MCP_PORT", "8765"))
    return LocalMcpBridge(backend, host=host, port=port)
