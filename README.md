# Firetrace

Firetrace is a local browser/CDP worker for deterministic endpoint capture.

It is designed for the workflow used in this project: request a screenshot, choose a click, execute it in the real browser, and capture the matching request/response (for example Yggdrasil `fn=play`) without manually debugging every game.

## Important Firecrawl finding

During implementation the current Firecrawl source was checked rather than assuming that its hosted browser API is part of the normal self-hosted stack.

Firecrawl's `/v2/browser` implementation calls a separate service through `HANGAR_URL`. That Hangar browser service is not part of Firecrawl's standard Docker Compose self-hosting stack. The scrape-bound `/interact` path also requires stored scrape context/database authentication, while Firecrawl's own self-hosting guide recommends starting with `USE_DB_AUTHENTICATION=false`.

Therefore Firetrace does **not** make the local workflow depend on an unavailable self-hosted browser service.

The default backend is local Chrome + Playwright/CDP. Firecrawl support remains optional for environments that actually provide the browser service.

## Normal use

On Windows, run:

```text
Firetrace-Worker.exe
```

The launcher:

1. reads the current Windows user configuration, even if Explorer has an older environment;
2. reuses Chrome CDP on `127.0.0.1:9222` if available;
3. otherwise starts Chrome with a private Firetrace profile and CDP bound to localhost;
4. detects the existing Cloudflare control configuration;
5. connects outbound to Cloudflare over WSS as agent `firetrace`;
6. receives commands in real time and sends results/state back through Cloudflare;
7. sends screenshots as binary frames for storage in the existing R2 bucket.

Missing Cloudflare credentials produce a clear error instead of silently starting
Git polling. The legacy GitHub transport is available only when explicitly selected
with `FIRETRACE_TRANSPORT=github`. The WSS transport does not poll the repository.

Opening the desktop worker does not update Git or deploy Cloudflare. Update the
executable explicitly when installing a new release. Console subprocesses run
hidden and noninteractively. Diagnostic output is saved to `.runtime/worker.log`.
The Restart worker button stops the current connection before starting another.

No browser/CDP port is exposed to the Internet.

For development:

```powershell
python -m pip install -e .
python -m firetrace.launcher
```

## Cloudflare transport

### ChatGPT MCP

The OAuth-enabled ChatGPT endpoint is
`https://firetrace-mcp.braian-n-l.workers.dev/mcp`.
Choose **OAuth** and leave client ID/secret empty. Complete the Firetrace
authorization page with your separate connection password.
The server implementation, tests and deployment instructions are in
[`cloudflare/`](cloudflare/README.md).

Keep the local agent running. The new MCP URL is only for ChatGPT; the local
agent continues using the existing `CF_CONTROL_URL` control-plane address.

Firetrace automatically uses the same persisted control-plane variables created for the existing MCP launcher:

```text
CF_CONTROL_URL
CF_CONTROL_TOKEN
```

Optional Firetrace-specific overrides are:

```text
FIRETRACE_CONTROL_URL
FIRETRACE_CONTROL_TOKEN
FIRETRACE_AGENT_ID
```

The default agent id is `firetrace`, so it does not collide with the older `main` browser agent.

The control path is:

```text
Cloudflare Worker -> Durable Object -> WSS -> Firetrace-Worker.exe -> Chrome/CDP
```

Chrome and CDP stay bound to localhost. The local worker initiates the outbound WSS connection; no inbound port is opened on the PC.

## Commands

The WSS transport accepts both the Firetrace names and the older browser aliases:

- `status`
- `open`
- `screenshot`
- `click`
- `click_relative`
- `wait`
- `network_clear`
- `network_events`
- `trigger_and_capture`

With Cloudflare enabled, command results are persisted by the Cloudflare control plane and screenshots are uploaded as binary WSS frames to R2. The files under `commands/` are retained only for the GitHub fallback transport.

Example capture command:

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

`trigger_and_capture` uses a CDP session and:

- enables the Network domain;
- records matching `Network.requestWillBeSent`;
- records matching `Network.responseReceived`;
- executes the click;
- retrieves the response with `Network.getResponseBody`;
- returns all matching request/response pairs;
- redacts authorization, cookies and equivalent sensitive headers before persistence.

## Optional Firecrawl backend

Set:

```text
FIRETRACE_BROWSER_BACKEND=firecrawl
```

only when the configured Firecrawl deployment actually exposes a working browser service. The stock self-hosted Compose stack alone is not enough for that feature.

## CI

GitHub Actions runs unit tests and compilation checks on every push. A separate Windows workflow builds `Firetrace-Worker.exe` and commits the current executable to the repository root.

## Safety

Use Firetrace only on systems and sites you are authorized to test.
