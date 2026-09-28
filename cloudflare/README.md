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
`shisetsu-browser-control` → WSS agent `firetrace` → local Chrome/CDP.

This Worker belongs to this repository. It does not deploy or alter the existing
control Worker. `CONTROL_TOKEN` is used only for the internal service request.
The existing D1 database and R2 bucket are read to retrieve screenshots by
command ID, so concurrent requests do not return an unrelated latest image.

Keep `Firetrace-Worker.exe` running on the PC with `CF_CONTROL_URL` and
`CF_CONTROL_TOKEN` configured. Those values still identify the **control Worker**,
not the new MCP URL. Chrome/CDP remain on localhost.

## Tools

- `browser_status`: agent connectivity and browser state.
- `browser_open`: HTTP(S) navigation.
- `browser_click`, `browser_click_relative`: pixel or normalized clicks.
- `browser_wait`: wait up to ten seconds.
- `browser_screenshot`: return a JPEG content block.
- `trigger_and_capture`: click and capture matching requests/responses.
- `network_events`, `network_clear`: backend compatibility commands; the local
  backend currently captures traffic atomically with `trigger_and_capture`.
- `command_result`: retrieve a long-running command without repeating it.

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

An unauthenticated HTTP 401 at `/mcp` is expected: its `WWW-Authenticate` header
now advertises OAuth discovery. It is not the old control-token-only rejection.

References: [OpenAI connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt),
[OpenAI authentication](https://developers.openai.com/plugins/build/auth),
[Cloudflare OAuth provider](https://github.com/cloudflare/workers-oauth-provider).
