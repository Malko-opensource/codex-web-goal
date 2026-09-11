# Operations and troubleshooting

For opt-in web-controlled execution, see [host integration and runner configuration](web-goal/web-controlled-execution.md).
The default remains local-supervised. Missing host scheduler support is a blocker, not a reason to poll the model.

For the expanded preflight, completion gate and incident procedures, see the Korean
[operations runbook](web-goal/operations-runbook.md) and [troubleshooting matrix](web-goal/troubleshooting.md).

## Common states

| State / error | Meaning | Local action |
| --- | --- | --- |
| `queued` | Persisted but not delivered | Start/pair Chrome; leave the selected chat open |
| `dispatching` | Delivery initiated; draft or UI may be busy | Inspect the selected tab; preserve manual drafts |
| `submitted` | Marker observed in the conversation | Wait; handle ChatGPT's tool confirmations or account prompts |
| `answered` | Stable rendered answer captured | Require `worker_finish`, seal, then verify locally |
| `uncertain` | Send may have happened; no safe proof either way | Open the existing conversation and reconnect; never blindly resend |
| `blocked` | Missing tab/composer or adapter error | Repair the UI/connection and retry observation |
| `sealed` | Remote writes revoked; source hash recorded | Run local verification and checkpoint |
| `WORKSPACE_DRIFT` | Source changed after seal | Inspect changes, reseal and rerun checks |
| `FILE_CHANGED` | File SHA no longer matches | Read the latest file and propose a new operation |
| `OPERATION_UNCERTAIN` | Filesystem intent/effect was interrupted | Inspect current file and private backup; reconcile locally |
| `NATIVE_GOAL` | Goal paused/replaced/complete or wrong binding | Check native Goal; close/rebind for a genuinely new goal |
| `SELECT_THREAD` | No unique loaded matching task | Open/resume Codex on the same App Server; pass its explicit ID |
| `WORKER_NOT_FINISHED` | Web answered without closing its grant | Ask Web to call `worker_finish` with its existing turn token |

Chrome `connected` and conversation `bound` are separate. A reload or replacement tab may keep the same
conversation URL but receive a new tab ID; the extension rebinds only that same normalized URL. Before ending a
session from a local TUI message, refresh bridge status and reconcile any submitted, working or uncertain turn.

When an uncertain send cannot be reconciled, pause the bridge, inspect the existing Web conversation and local changes,
then resume with a new bounded task only after deciding whether repeating work is safe. There is no “force resend” button.
If Web's final answer arrived before `worker_finish`, it can still close the turn using its existing token, but cannot edit again.
If the token is unavailable or the Web model will not complete the handshake, pause and reconcile locally, then begin a fresh task.
A normal reconnect alone cannot repair an omitted completion handshake.

Native App Server disconnection pauses the bridge on the next monitor check, and writes also check native state immediately.
Restart the server, resume the original Codex task, inspect partial changes, then resume the bridge from local control.
Persisted terminal states and revoked write grants survive restart. The browser and native process are not a hosted always-on service.

## Existing App Server

```sh
node dist/cli.js start --workspace /absolute/repo --codex-url ws://127.0.0.1:PORT
```

The existing server must expose the native Goal methods and load this plugin/control MCP in its agent configuration.
It must serve the same workspace and trust the same private state directory. The bridge will not stop a server it did not start.
Do not point this at a Desktop-internal socket or assume the Desktop task is on the selected listener.
For the default launcher the control MCP is explicitly injected into the owned server; the plugin supplies supervisor instructions.

## File constraints

Remote text tools support valid UTF-8 regular files up to 2 MiB, exact unique-text edits and at most 20,000 indexed files.
Read results are paginated by lines; the returned SHA always covers the whole file, not the selected lines.
Do not replace a large existing file from a truncated read. Use narrow exact edits or fetch all necessary ranges.
Search is literal and capped; it is not shell access. Exclusions are currently fixed in `src/workspace.ts`.
Dependencies/build output are managed by local execution, not remote text writes.

Backup filenames are recorded in operation history and stored in `<state-dir>/backups`.
Copy a chosen backup back only after inspecting the current file and confirming that no unrelated changes will be lost.
No automatic rollback or automatic deletion of history/backups is performed.

## Release and local installation

`npm run release` builds unpacked artifacts and ZIPs. `npm pack` can package the Node CLI; it does not publish it.
Chrome Web Store, npm and GitHub publication require separate maintainer actions. No repository URL or namespace has been reserved.
The plugin bundle is self-contained but requires Node on PATH. CLI source installs use `npm ci` before build.

Manual account-backed acceptance checklist before calling a release production-ready:

1. Use a disposable repository with no credentials and an authorized ChatGPT account.
2. Verify MCP discovery, read, SHA-guarded edit and a denied out-of-workspace read.
3. Run one explicit native `/goal $web-goal` with three real Web/local cycles; inspect real diffs and local command evidence.
4. Test Web tool-confirmation prompts, a browser reload during generation, a saved partial response, and native Goal pause.
5. Confirm a manual Web message does not become a local Goal instruction; remember it still changes Web context.
6. Verify logs/screenshots never expose credentials, and stop the tunnel afterward.

## Verified vs unverified

Automated fixtures exercise real Chrome-extension code, MCP transport, local file effects, local execution, reconnects,
manual-message boundaries, draft preservation and uncertain-send recovery. The native smoke test checks the installed
Codex protocol and plugin-to-bridge calls using an isolated, ephemeral test thread without model turns or changes to user tasks/configuration. Neither test proves that today's ChatGPT DOM or its model will comply
with the completion protocol. UI selectors, model behavior, tool approvals and account policies require the checklist above.
