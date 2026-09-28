import json
from firetrace.firecrawl import FirecrawlBackend, FirecrawlClient

class FakeClient(FirecrawlClient):
    def __init__(self):
        pass
    def create_browser(self, ttl=900):
        return "sid"
    def browser_status(self, sid):
        return {"success":True,"status":"active"}
    def execute(self, sid, code, timeout=30):
        if "screenshot" in code:
            return {"success":True,"exitCode":0,"stdout":"YWJj\n"}
        if "__FIRETRACE__" in code:
            payload={"captures":[{
                "url":"https://demo.test/?fn=play",
                "method":"POST",
                "headers":{"Cookie":"secret","X":"y"},
                "responseHeaders":{"Set-Cookie":"secret2"},
                "status":200,
                "postData":"cmd=TEST",
                "responseBody":"{}"
            }]}
            return {"success":True,"exitCode":0,"stdout":"noise\n__FIRETRACE__"+json.dumps(payload)+"\n"}
        return {"success":True,"exitCode":0,"stdout":"ok\n"}

def test_screenshot_decodes_base64():
    b=FirecrawlBackend(FakeClient())
    assert b.screenshot()==b"abc"

def test_capture_parses_and_redacts():
    b=FirecrawlBackend(FakeClient())
    got=b.trigger_and_capture(x=1,y=2)
    assert got["captures"][0]["postData"]=="cmd=TEST"
    assert got["captures"][0]["headers"]["Cookie"]=="[REDACTED]"
    assert got["captures"][0]["responseHeaders"]["Set-Cookie"]=="[REDACTED]"
