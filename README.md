# Firetrace

Firetrace is the local browser/CDP + MCP bridge used to control a real browser, take screenshots, click, inspect network traffic and save HAR captures.

The default architecture is now entirely local:

```text
ChatGPT Desktop / Codex
        ↓
http://127.0.0.1:8765/mcp
        ↓
Firetrace
        ↓
Chrome/Edge or Playwright Chromium
        ↓
CDP / Network / HAR
```

Cloudflare is optional and is no longer required for normal local use.

## Windows: pull and run

From an existing checkout:

```powershell
cd C:\firetrace
git pull
.\run-firetrace.ps1
```

Or double-click:

```text
run-firetrace.cmd
```

The launcher creates `.venv` if needed, installs/updates the package, ensures Playwright Chromium is available, and starts the Firetrace GUI.

The GUI shows the MCP URL and has a **Copy MCP URL** button.

## Local MCP

Default endpoint:

```text
http://127.0.0.1:8765/mcp
```

Health endpoint:

```text
http://127.0.0.1:8765/health
```

PowerShell health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
```

Expected service name:

```text
firetrace-local-mcp
```

The server is stateless Streamable HTTP MCP and binds to localhost by default.

### ChatGPT setup

Create a local custom MCP/App with:

```text
Name: Firetrace
Type: HTTP with streaming
URL: http://127.0.0.1:8765/mcp
Bearer token: empty
Headers: empty
```

Keep Firetrace running while using the app.

The local MCP exposes:

- `browser_status`
- `browser_open`
- `browser_click`
- `browser_click_relative`
- `browser_wait`
- `browser_screenshot`
- `network_events`
- `network_clear`
- `trigger_and_capture`
- `record_start`
- `record_status`
- `record_save`
- `sequence`

Example:

```text
@Firetrace use browser_status and tell me which page is open.
```

Full HAR workflow:

```text
record_start
→ browser actions
→ record_status
→ record_save
```

HAR files are saved by default to:

```text
%USERPROFILE%\Downloads\Firetrace-HARs\
```

Override with:

```text
FIRETRACE_HAR_DIR
```

## Browser startup

Firetrace first looks for an existing CDP endpoint on:

```text
http://127.0.0.1:9222
```

If none exists on Windows it starts Chrome or Edge with a private Firetrace profile and CDP bound to localhost.

If Chrome/Edge is unavailable, the development launcher can fall back to Playwright Chromium.

No CDP port is exposed to the Internet.

## trigger_and_capture

`trigger_and_capture` opens a temporary CDP Network session, performs one requested click and returns matching request/response data.

Example arguments:

```json
{
  "url_contains": "fn=play",
  "rx": 0.54,
  "ry": 0.54,
  "wait_ms": 2500
}
```

It captures:

- URL and method
- request headers
- POST data
- response status and headers
- response body when Chromium exposes it

Sensitive authorization, cookie and API-key headers are redacted from returned network captures.

## Full HAR recording

`record_start` begins a persistent CDP Network recording without reloading the current page.

`record_status` reports:

- elapsed time
- request count
- response count
- WebSocket frame count

`record_save` stops recording and writes a HAR containing HTTP traffic and captured WebSocket frames.

## Configuration

Normal local use requires no environment variables.

Optional local settings:

```text
FIRETRACE_MCP_HOST=127.0.0.1
FIRETRACE_MCP_PORT=8765
FIRETRACE_CDP_URL=http://127.0.0.1:9222
FIRETRACE_HEADLESS=0
FIRETRACE_HAR_DIR=C:\some\folder
```

Default transport:

```text
FIRETRACE_TRANSPORT=local
```

## Optional Cloudflare transport

The previous Cloudflare WSS transport remains available for remote access, but it is opt-in:

```text
FIRETRACE_TRANSPORT=cloudflare
CF_CONTROL_URL=...
CF_CONTROL_TOKEN=...
```

Firetrace-specific overrides are also supported:

```text
FIRETRACE_CONTROL_URL
FIRETRACE_CONTROL_TOKEN
FIRETRACE_AGENT_ID
```

The old GitHub polling transport is also still available explicitly with:

```text
FIRETRACE_TRANSPORT=github
```

Neither Cloudflare nor GitHub is used when the default local transport is active.

## Development

Python 3.11+:

```powershell
python -m pip install -e . pytest
python -m playwright install chromium
pytest -q
python -m firetrace.gui
```

CLI without the GUI:

```powershell
firetrace
```

GUI entry point:

```powershell
firetrace-gui
```

## Windows executable

GitHub Actions builds `Firetrace-Worker.exe` when Firetrace source changes and publishes the current executable back to the repository root.

For immediate development after a pull, `run-firetrace.ps1` is the canonical path because it always runs the checked-out source.

## CI

CI validates:

- Python compilation
- local MCP initialization and tool discovery
- local MCP tool calls
- screenshot content blocks
- local/default transport selection
- browser + CDP request/response capture
- full HAR recording and save

## Safety

Use Firetrace only on systems and services you are authorized to test or automate.
