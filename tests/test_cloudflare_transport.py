from firetrace.cloudflare_agent import ws_url


def test_ws_url_https():
    assert ws_url("https://example.workers.dev", "firetrace") == (
        "wss://example.workers.dev/ws?agent_id=firetrace"
    )


def test_ws_url_quotes_agent_id():
    assert ws_url("http://localhost:8787/", "fire trace") == (
        "ws://localhost:8787/ws?agent_id=fire%20trace"
    )


def test_normalize_browser_aliases():
    from firetrace.cloudflare_agent import CloudflareFiretraceAgent
    assert CloudflareFiretraceAgent.normalize_action("browser_status") == "status"
    assert CloudflareFiretraceAgent.normalize_action("browser_screenshot") == "screenshot"
    assert CloudflareFiretraceAgent.normalize_action("trigger_and_capture") == "trigger_and_capture"
