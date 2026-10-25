import base64
import json

import pytest

from firetrace.github_remote import (
    SESSION_RE, Session, safe_url, scrub, summarize_har, validate_demo_url
)


def test_identifiers_are_bounded_and_safe():
    assert SESSION_RE.fullmatch("demo-20261025-001")
    assert not SESSION_RE.fullmatch("../outside")
    assert not SESSION_RE.fullmatch("z" * 65)


def test_demo_host_allowlist_blocks_internal_urls_and_credentials():
    hosts = ["pragmaticplay.fun"]
    validate_demo_url("https://www.pragmaticplay.fun/en/slots/test/", hosts)
    with pytest.raises(ValueError):
        validate_demo_url("https://localhost/private", hosts)
    with pytest.raises(ValueError):
        validate_demo_url("http://www.pragmaticplay.fun/en/slots/test/", hosts)
    with pytest.raises(ValueError):
        validate_demo_url("https://evil.pragmaticplay.fun.attacker.test/", hosts)
    with pytest.raises(ValueError):
        validate_demo_url("https://user:pass@pragmaticplay.fun/", hosts)


def test_scrub_observations_and_nested_har():
    item = {
        "url": "https://demo.example/play?token=abc123&level=4#secret",
        "headers": [{"name": "Authorization", "value": "Bearer private"},
                    {"name": "Content-Type", "value": "application/json"}],
        "postData": {"text": '{"balance":12,"access_token":"abc"}'},
        "frames": [{"opcode": 2, "payloadData": "encoded-binary"}],
        "body": {"encoding": "base64", "text": "raw-binary"},
        "location": "https://demo.example/play?launch_token=private5&bet=2",
    }
    cleaned = scrub(item)
    encoded = json.dumps(cleaned)
    assert "abc123" not in encoded
    assert "private" not in encoded
    assert "raw-binary" not in encoded
    assert "encoded-binary" not in encoded
    assert "private5" not in encoded
    assert cleaned["headers"][1]["value"] == "application/json"
    assert cleaned["postData"]["text"] == '{"balance": 12, "access_token": "[REDACTED]"}'
    assert "level=4" in cleaned["url"]


def test_screenshot_base64_preserved_for_visual_navigation():
    image = base64.b64encode(b"\xff\xd8" * 15000).decode()
    assert scrub({"image_base64":image})["image_base64"] == image


def test_har_endpoint_and_websocket_summary():
    entry = {
        "request":{"method":"POST","url":"https://a.example/doSpin?bl=1",
                   "postData":{"text":"bet=2"}},
        "response":{"status":200,"content":{"text":"ok"}},
        "_webSocketFrames":[{"direction":"sent","payloadData":"{\"spin\":1}"}]
    }
    result = summarize_har({"log":{"entries":[entry,entry]}})
    assert result["http_entries"] == 2
    assert result["ws_frames"] == 2
    assert result["endpoints"][0]["count"] == 2
    assert result["endpoints"][0]["query_keys"] == ["bl"]


def test_remote_capture_never_publishes_raw_har(monkeypatch, tmp_path):
    raw_path = tmp_path / "raw.har"
    raw_path.write_text(json.dumps({"log":{"entries":[{
        "request":{"url":"https://demo.example/api?access_token=private1",
                   "method":"POST","headers":[],
                   "postData":{"text":'{"bet":3,"password":"private2"}'}},
        "response":{"status":200,"content":{"text":'{"win":4,"api_key":"private3"}'}},
        "_webSocketFrames":[{"direction":"sent","opcode":1,
                             "payloadData":'{"balance":10,"token":"private4"}'}]
    }]}}), encoding="utf-8")

    class Backend:
        def __init__(self, **_):
            self.page = None
        def record_start(self):
            return {"recording":True}
        def record_status(self):
            return {"recording":False}
        def record_save(self):
            return {"path":str(raw_path)}
        def close(self):
            pass

    monkeypatch.setattr("firetrace.github_remote.LocalBrowserBackend", Backend)
    session = Session("safe-test", tmp_path / "artifacts", ["demo.example"])
    report = session.save_har()
    assert report["entries"] == 1
    assert not raw_path.exists()
    saved = (tmp_path / "artifacts" / report["capture"]).read_text(encoding="utf-8")
    for value in ["private1","private2","private3","private4"]:
        assert value not in saved
    assert "bet" in saved and "win" in saved


def test_dynamic_api_entries_are_ranked_before_static_assets():
    har = {"log":{"entries":[
      {"request":{"method":"GET","url":"https://demo.example/assets/big.jpg"},
       "response":{"status":200}},
      {"request":{"method":"POST","url":"https://demo.example/api/spin",
                  "postData":{"text":"bet=1"}},"response":{"status":200}}
    ]}}
    report = summarize_har(har)
    assert report["endpoints"][0]["method"] == "POST"
    assert report["endpoints"][0]["path"] == "/api/spin"
