# Independent browser sessions

Approved design: GPT controls multiple simultaneous windows, each with a separate
Chromium process and profile. Temporary sessions discard data; named persistent
profiles survive restart. Closing every window does not stop the agent.

Implementation in this session:
- [ ] Add a session manager around the existing page backend, lazy browser startup,
  stable browser_id routing, create/list/close/reopen, max four live processes
  (FIRETRACE_MAX_BROWSERS), named profiles under the local application data directory.
- [ ] Route worker commands and screenshot upload by browser_id. Omitted IDs use
  a legacy default only when there is no ambiguity. Never attach to personal Chrome.
- [ ] Expose lifecycle tools and browser_id in MCP schemas, with clear lifecycle
  errors and descriptions. Keep existing tools compatible for one browser.
- [ ] Test simultaneous cookie/storage isolation, temporary reset, persistent
  recovery after agent restart, manual close, limit, invalid profile paths,
  ambiguous routing, screenshot routing, and unchanged network capture.
- [ ] Build/install Windows executable, deploy MCP, verify advertised tools and
  lifecycle commands using owned empty test windows, and publish changes.

Processes isolate browser state and failures, not the OS user or network identity.
Profiles cannot be active twice; profile names are restricted lowercase identifiers.
Only explicit create/reopen or legacy open creates windows; clicks never reopen or
fall back to another session. Closing persistent sessions never deletes profiles.
Commands remain serialized by the worker, while all browser pages run concurrently.
