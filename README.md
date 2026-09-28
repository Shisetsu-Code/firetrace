# Firetrace

Local Firecrawl/CDP worker for browser automation and deterministic endpoint capture.

## Purpose

Firetrace keeps Firecrawl and browser control on the local machine while using a small command queue in this repository. The main operation, `trigger_and_capture`, creates a CDP session, enables the Network domain, performs a click, and returns matching request/response pairs including request post data and response bodies.

Sensitive authentication/cookie headers are redacted before results are persisted.

## Local start

Requirements: Windows/Linux with Python 3.11+, Git and Docker Desktop/Engine.

```powershell
git clone https://github.com/Shisetsu-Code/firetrace.git
cd firetrace
python -m pip install -e .
python -m firetrace.launcher
```

The launcher pins Firecrawl to `v2.11.0`, clones it into `.runtime/firecrawl`, starts its official Docker Compose stack, waits for the local API, then starts the command worker.

Firecrawl is used locally at `http://127.0.0.1:3002`. Do not expose Firecrawl or browser/CDP ports publicly.

## Commands

Write `commands/current.json` with a unique id and one of:

- `status`
- `open`
- `screenshot`
- `click`
- `click_relative`
- `wait`
- `network_clear`
- `network_events`
- `trigger_and_capture`

Example:

```json
{
  "id": "capture-001",
  "action": "trigger_and_capture",
  "args": {
    "url_contains": "fn=play",
    "rx": 0.54,
    "ry": 0.54,
    "wait_ms": 2500
  }
}
```

Results are written to `commands/result.json`; screenshots are written to `commands/latest.jpg`.

## Why /v2/browser instead of scrape-bound /interact

Firetrace uses Firecrawl's direct `/v2/browser` and `/v2/browser/:sessionId/execute` APIs. Current Firecrawl self-hosting documentation recommends `USE_DB_AUTHENTICATION=false` for the baseline stack, while scrape-bound `/interact` requires stored scrape context/database authentication. The direct browser API still provides Node execution with `page`, `context`, and CDP access, which is exactly what Firetrace needs.

## Safety

Only use Firetrace on systems and sites you are authorized to test.
