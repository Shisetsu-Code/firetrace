from firetrace.redact import redact_capture, redact_headers

def test_redacts_sensitive_headers_case_insensitive():
    got = redact_headers({"Authorization":"abc","cookie":"x","X-Test":"ok"})
    assert got["Authorization"] == "[REDACTED]"
    assert got["cookie"] == "[REDACTED]"
    assert got["X-Test"] == "ok"

def test_redacts_request_and_response():
    got = redact_capture({
        "headers":{"Cookie":"a"},
        "responseHeaders":{"Set-Cookie":"b"},
        "url":"https://example.test"
    })
    assert got["headers"]["Cookie"] == "[REDACTED]"
    assert got["responseHeaders"]["Set-Cookie"] == "[REDACTED]"
