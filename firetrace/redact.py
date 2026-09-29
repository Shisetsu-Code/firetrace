from __future__ import annotations
import json
import re
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

SENSITIVE = {
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
    "api-key",
}


def sensitive(key):
    normalized=re.sub(r'[^a-z0-9]','',str(key).lower())
    return any(part in normalized for part in ('token','secret','password','authorization','cookie','apikey','signature','credential','sessionid','sessionkey')) or normalized in ('auth','sid','jwt')


def safe_url(url):
    try:
        p=urlsplit(url)
        host=p.hostname or ''
        if ':' in host: host=f'[{host}]'
        if p.port: host+=f':{p.port}'
        return urlunsplit((p.scheme,host,p.path,urlencode([(k,'[REDACTED]' if sensitive(k) else v) for k,v in parse_qsl(p.query,keep_blank_values=True)]),''))
    except (ValueError,TypeError): return '[invalid URL]'


def sanitize(value):
    if isinstance(value,dict):
        return {str(k):'[REDACTED]' if sensitive(k) else sanitize(v) for k,v in value.items()}
    if isinstance(value,list): return [sanitize(v) for v in value]
    if isinstance(value,str) and value.startswith(('http://','https://')): return safe_url(value)
    return value


def safe_body(body, content_type):
    if body is None: return None
    try:
        if 'json' in content_type.lower(): return json.dumps(sanitize(json.loads(body)),ensure_ascii=False)
        if 'application/x-www-form-urlencoded' in content_type.lower():
            return urlencode([(k,'[REDACTED]' if sensitive(k) else v) for k,v in parse_qsl(body,keep_blank_values=True)])
    except (ValueError,TypeError): pass
    return '[OMITTED: unsupported body format]'

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
