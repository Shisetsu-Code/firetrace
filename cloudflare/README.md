# Firetrace MCP for ChatGPT

Production endpoint: **https://firetrace-mcp.braian-n-l.workers.dev/mcp**

Use **OAuth** authentication. Leave the OAuth client ID and secret empty: the
server supports dynamic client registration and client metadata documents.
When redirected to Firetrace, enter your separate connection password and
approve access. Do not enter `CF_CONTROL_TOKEN` in ChatGPT.

The connection password is stored as the `MCP_PASSWORD` Worker secret. The
initial connection instructions and password are kept locally by the operator,
outside this public repository.

## Architecture

ChatGPT → OAuth-protected Firetrace MCP → service binding to
`shisetsu-browser-control` → WSS agent `firetrace` → isolated Chromium processes.

This Worker belongs to this repository. It does not deploy or alter the existing
control Worker. `CONTROL_TOKEN` is used only for the internal service request.
The existing D1 database and R2 bucket are read to retrieve screenshots by
command ID, so concurrent requests do not return an unrelated latest image.

Keep `Firetrace-Worker.exe` running on the PC with `CF_CONTROL_URL` and
`CF_CONTROL_TOKEN` configured. Those values still identify the **control Worker**,
not the new MCP URL. Browser processes run locally; personal Chrome is not attached.

## Tools

The server advertises **35 tools** through `tools/list`, and sends a workflow
guide in the MCP `initialize.instructions` field. ChatGPT receives these protocol
descriptions; it does not automatically read this repository's Markdown files.

- `browser_status`: agent connectivity and browser state.
- `browser_create`: open an independent browser, temporary or persistent, with
  `headless: true` for background work or `false` for a visible window.
- `browser_list`: list window IDs, saved profiles and the concurrent window limit.
- `browser_close`: close the specified window without stopping the agent.
- `browser_reopen`: reopen a closed ID, retaining data only for persistent profiles.
  Preserves headless mode unless explicitly overridden while the browser is closed.
- `browser_open`: HTTP(S) navigation.
- `browser_click`, `browser_click_relative`: pixel or normalized clicks.
- `browser_wait`: wait up to ten seconds.
- `browser_screenshot`: return a JPEG content block.
- `trigger_and_capture`: click and capture matching requests/responses.
- `network_events`, `network_clear`: backend compatibility commands; the local
  backend currently captures traffic atomically with `trigger_and_capture`.
- `command_result`: retrieve a long-running command without repeating it.

Use `browser_id` from create/list for every page action when multiple windows
are open. Example: create two sessions with `{"mode":"temporary"}` and
`{"mode":"persistent","profile":"programa-a"}`, then navigate each with
`browser_open({"browser_id":"<returned ID>","url":"http://localhost:3000"})`.
See [session semantics and configuration](../docs/browser-sessions.md).

Click/navigation tools are correctly annotated as actions, not read-only tools.
If an RPC returns `status: running`, use its ID with `command_result`; do not
repeat the action. The adapter checks agent liveness before sending a command.
The existing control plane still owns delivery/queue semantics if the agent
disconnects during that request.

## Development and deployment

Node 22 or newer:

```sh
npm ci
npm test
npm run check
```

`npm test` builds the Worker and tests OAuth inside the actual Workers runtime,
plus MCP protocol/tool behavior and bridge failure handling.

The checked-in configuration targets the existing owner account. For another
account, change the Worker/service/database/bucket/KV bindings and `PUBLIC_URL`.

Create an ignored `secrets.json` locally with `CONTROL_TOKEN` and a long random
`MCP_PASSWORD`, then deploy both secrets atomically with the Worker:

```sh
npx wrangler deploy --secrets-file secrets.json
```

Never commit that file. For local development supply the same values through an
ignored `.dev.vars` and use suitable local bindings.

`node smoke.mjs` performs a production OAuth/PKCE exchange, rejects a wrong
password and a missing consent cookie, lists tools, reads `browser_status`,
refreshes the token and revokes the verification grant. It reads `secrets.json`
without printing credentials. It does not click or navigate the browser.

## ChatGPT setup

Enable developer mode in ChatGPT, create a custom app/plugin, enter the endpoint
above, choose OAuth, and complete the Firetrace consent page. Then select
Firetrace in a chat and request `browser_status` first.

### New tools missing in ChatGPT

1. Verify the connection URL is exactly
   `https://firetrace-mcp.braian-n-l.workers.dev/mcp`, not the control Worker URL.
2. Open the Firetrace connection at [ChatGPT Plugins](https://chatgpt.com/plugins).
3. Select **Refresh** to import updated tools, descriptions and server instructions.
4. Confirm that all 14 tools are listed and the four lifecycle tools are enabled.
5. Start a new chat and select Firetrace. Ask: "Use Firetrace browser_list to list
   browser sessions. Then use browser_create to open two independent temporary windows."

If those tools are absent from the connection's list, the catalog has not updated;
changing the prompt cannot add tools. If listed but unused, check that Firetrace
is selected in the conversation and the tools are enabled. The server cannot
force-refresh the catalog stored in a user's ChatGPT connection.

Official procedure: [refresh MCP metadata](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).

An unauthenticated HTTP 401 at `/mcp` is expected: its `WWW-Authenticate` header
now advertises OAuth discovery. It is not the old control-token-only rejection.

References: [OpenAI connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt),
[OpenAI authentication](https://developers.openai.com/plugins/build/auth),
[Cloudflare OAuth provider](https://github.com/cloudflare/workers-oauth-provider).

For the complete automation catalog and examples, see [Firetrace automation](../docs/automation.md).
