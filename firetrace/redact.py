from __future__ import annotations

SENSITIVE = {
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
    "api-key",
}

def redact_headers(headers: dict | None) -> dict:
    if not headers:
        return {}
    out = {}
    for key, value in headers.items():
        out[key] = "[REDACTED]" if str(key).lower() in SENSITIVE else value
    return out

def redact_capture(capture: dict) -> dict:
    capture = dict(capture)
    if "headers" in capture:
        capture["headers"] = redact_headers(capture["headers"])
    if "responseHeaders" in capture:
        capture["responseHeaders"] = redact_headers(capture["responseHeaders"])
    return capture
