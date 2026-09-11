# Security boundaries

This is a single-user development tool, not a multi-tenant service. File-tool checks are not an OS sandbox;
the opt-in Mac runner applies a separate Seatbelt policy and egress proxy.
Use a disposable clone for initial trials. Keep the native Codex sandbox and approvals enabled.

- Only expose the MCP listener (default 43120) through HTTPS. Never tunnel control (43121) or Codex (43122).
- The MCP URL contains a 256-bit capability token. Anyone with the URL can use the enabled file tools.
  Tokens may appear in tunnel/provider logs and ChatGPT connection configuration. Do not publish screenshots containing them.
- The dashboard uses a separate bearer token and local Host/Origin validation. Extension pairing uses a short-lived,
  one-time code; the extension receives a separate credential. The WebSocket requires that extension's origin and credential.
- Goal write tokens are visible in the selected Web conversation. They authorize a turn, **not a human identity**.
  A participant or hostile page content that obtains the token is not cryptographically isolated from the Web worker.
- Treat screenshots, DOM dumps, accessibility trees, automation traces and error messages as sensitive logs. They can
  expose a turn token, tokenized MCP URL, conversation URL or source. Redact them before storage or sharing.
- Workspace tools reject path escape, symlinks, multiply-linked files, special files, protected instruction writes,
  `.git`, `.codex`, `.agents`, common credential names, generated directories, binary content and invalid UTF-8.
  These are application checks, not protection from a hostile local process racing filesystem changes.
- Secret-name filtering is not a secret scanner. Credentials inside otherwise normal source files can be transmitted.
- File writes need an expected SHA and operation ID. Pre-change backups are kept in private local state.
  Inspect partial changes after failures. A multi-file change is not transactional.
- Plan and local-supervised Goal sessions cannot execute Web commands. Explicit web-controlled Goal sessions
  permit commands only after host wait, context acknowledgement and execution-policy checks.
  Direct-mode commands require local approval of the exact shell text.
  An approved shell command has your OS user's privileges and can access outside the selected workspace; review it accordingly.
- Ordinary Web file changes are authorized by selecting/exposing the MCP workspace, not by a second dashboard prompt per edit.
  ChatGPT may also require its own tool confirmations. No confirmation, CAPTCHA, login or rate-limit bypass is implemented.
- Local Codex verification can execute untrusted repository code. Use Codex's normal sandbox and approvals; review scripts first.
- Changing ChatGPT model, conversation or account does not strengthen isolation. Manual and automated messages share context.

The bridge makes no network request to GitLab. VPN access to GitLab is used by your local clone/Git tooling.
However, sending repository contents to ChatGPT and using a public tunnel are data-egress decisions.
Confirm employer policy, account data controls, tunnel-provider handling and applicable service terms before using company code.
No telemetry or third-party analytics is implemented by this project. Dependencies and external products have their own behavior.

The current tokenized URL/no-OAuth connector is for controlled development use. A successful MCP connection does not
prove production-safe authentication. Removing the visible turn token requires a different per-turn authorization channel
or server-side session binding without widening the MCP URL credential; that redesign is not implemented.

See the expanded Korean [security boundary](docs/web-goal/security-boundary.md).

## Opt-in runner boundary

Commands run in a disposable copy, with selected tool installations, a clean environment and no shared writable
links to source. The native sandbox permits network access only through its per-run public-address proxy and
explicitly inherited local-service sockets. HTTP/CONNECT DNS answers are checked and a public address is pinned;
private/mapped/reserved addresses and configured `--deny-egress-host` names are denied. Deny the public tunnel
hostname as well. Arbitrary direct sockets, user SSH agents and the host wait socket are not exposed.
Do not grant broad directories as `--tool-root`; include only the runtime and required library installations.
Metadata reads remain possible; this is not a filesystem namespace container or a secret scanner.

The watchdog kills the sandbox process group on timeout, cancellation and parent-pipe EOF. Deliberately
daemonized descendants that escape that process group are **not yet a verified containment guarantee**;
hostile-code/production activation must remain blocked pending that acceptance test and stronger supervision.
The stock host wait hook and real-account zero-model behavior are also unverified. Host capability responses
are an integration contract, not evidence that an arbitrary server actually enforces the scheduler hook.
Existing visible turn-token/capability-URL limitations still apply. No OAuth retrofit is implied.

## Selected resources and MCP relay

The optional resource manifest must be outside remotely writable source. Registration is explicit and selected
resource digests are pinned in the delegation context; it does not discover or expose all installed plugins.
Image bytes are returned as MCP image content, not silently uploaded to a browser composer. Confirm that each
selected resource may be disclosed to the Web provider. Filename checks are not a comprehensive secret scanner.

Approved MCP calls run on the configured MCP server, **not inside the Mac job sandbox**. Its implementation and
service credentials own the actual effect boundary. Only the configured tool may be called, each exact invocation
requires dashboard approval, redirects are rejected, and authentication header values stay on the execution side.
Tool schema descriptions and outputs are untrusted data, not authority to expand grants. A timeout/restart can leave
effects uncertain; never replay blindly. Cancellation does not undo a service mutation. Local assistance likewise
requires the real host to validate the originating user-input generation before resuming any model work.

## Reporting

Do not put tokens, real source code, conversation URLs or state snapshots in a public issue.
Use the private security reporting channel of the repository where this project is published.
Until a maintainer has configured that channel, report only a minimal redacted reproduction privately to that maintainer.

## Credential rotation

Stop the daemon and tunnel first. Preserve the private state directory if you need its backups/evidence.
Start with a new private `--state-dir`, reconnect ChatGPT using the new MCP URL, and pair the extension again.
The old endpoint must remain stopped. This creates new credentials; it does not migrate the old session automatically.
