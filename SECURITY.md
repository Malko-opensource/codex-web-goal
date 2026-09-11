# Security boundaries

This is a single-user development tool, not a multi-tenant service or an OS sandbox.
Use a disposable clone for initial trials. Keep the native Codex sandbox and approvals enabled.

- Only expose the MCP listener (default 43120) through HTTPS. Never tunnel control (43121) or Codex (43122).
- The MCP URL contains a 256-bit capability token. Anyone with the URL can use the enabled file tools.
  Tokens may appear in tunnel/provider logs and ChatGPT connection configuration. Do not publish screenshots containing them.
- The dashboard uses a separate bearer token and local Host/Origin validation. Extension pairing uses a short-lived,
  one-time code; the extension receives a separate credential. The WebSocket requires that extension's origin and credential.
- Goal write tokens are visible in the selected Web conversation. They authorize a turn, **not a human identity**.
  A participant or hostile page content that obtains the token is not cryptographically isolated from the Web worker.
- Workspace tools reject path escape, symlinks, multiply-linked files, special files, protected instruction writes,
  `.git`, `.codex`, `.agents`, common credential names, generated directories, binary content and invalid UTF-8.
  These are application checks, not protection from a hostile local process racing filesystem changes.
- Secret-name filtering is not a secret scanner. Credentials inside otherwise normal source files can be transmitted.
- File writes need an expected SHA and operation ID. Pre-change backups are kept in private local state.
  Inspect partial changes after failures. A multi-file change is not transactional.
- During Plan/Goal, Web cannot run commands. Direct-mode commands require local approval of the exact shell text.
  An approved shell command has your OS user's privileges and can access outside the selected workspace; review it accordingly.
- Ordinary Web file changes are authorized by selecting/exposing the MCP workspace, not by a second dashboard prompt per edit.
  ChatGPT may also require its own tool confirmations. No confirmation, CAPTCHA, login or rate-limit bypass is implemented.
- Local Codex verification can execute untrusted repository code. Use Codex's normal sandbox and approvals; review scripts first.
- Changing ChatGPT model, conversation or account does not strengthen isolation. Manual and automated messages share context.

The bridge makes no network request to GitLab. VPN access to GitLab is used by your local clone/Git tooling.
However, sending repository contents to ChatGPT and using a public tunnel are data-egress decisions.
Confirm employer policy, account data controls, tunnel-provider handling and applicable service terms before using company code.
No telemetry or third-party analytics is implemented by this project. Dependencies and external products have their own behavior.

## Reporting

Do not put tokens, real source code, conversation URLs or state snapshots in a public issue.
Use the private security reporting channel of the repository where this project is published.
Until a maintainer has configured that channel, report only a minimal redacted reproduction privately to that maintainer.

## Credential rotation

Stop the daemon and tunnel first. Preserve the private state directory if you need its backups/evidence.
Start with a new private `--state-dir`, reconnect ChatGPT using the new MCP URL, and pair the extension again.
The old endpoint must remain stopped. This creates new credentials; it does not migrate the old session automatically.
