# Architecture and contracts

## Ownership

| Owner | Authoritative state | Allowed effects |
| --- | --- | --- |
| Native Codex | Objective, Goal budget/status/completion, local approvals | Execute tests, inspect changes, decide next task and Git operations |
| Bridge | Session binding, delivery journal, file operations, leases, checkpoints | Grant/revoke a single Web turn; apply bounded workspace changes |
| Chrome extension | Selected rendered conversation, durable send-attempt journal | Submit visible text and observe rendered responses |
| ChatGPT Web | Design and implementation proposals | Read/write through the workspace MCP; finish its own work |

The bridge reads native `thread/read`, `thread/loaded/list`, `thread/goal/get` over a loopback App Server connection.
It never calls `thread/goal/set`, `turn/start`, or `thread/resume`. The user-facing Codex TUI owns the actual agent loop.
A binding includes native thread ID, Goal creation time and objective; replacement cannot silently reuse a prior binding.
This follows the [native App Server Goal contract](https://developers.openai.com/codex/app-server/).

The explicit `$web-goal` skill is behavioral guidance for the local agent, not an engine-level hook.
It requests the same delegation policy after each native continuation and compaction; the native model must follow it.
The bridge enforces file/command capabilities, but cannot force Codex to delegate on every turn or prevent it writing locally.

## One work cycle

```text
queued → dispatching → submitted → answered → sealed → checked
             ↘ uncertain / blocked ↗                ↓
                 reconcile only                 next turn
```

`request_id` is stable across a retry; changed content under the same ID is rejected.
The local supervisor supplies one task, relevant checkpoint context, acceptance criteria and an optional deletion grant.
The bridge embeds a per-turn write token in that visible prompt. Web must call `worker_context` before work and
`worker_finish` before its final answer. Finish closes the write grant; the browser then captures the answer.
`web_goal_seal` revokes the token and records a source hash. Local checks run after this boundary.
`web_goal_checkpoint` accepts evidence only for the same source hash. It does not mutate native Goal status.
Checks are attestations by the trusted local supervisor, not independently proven execution transcripts.

Plan sessions grant no remote writes or commands. A code pass requires at least one reported successful local check.
A source seal excludes generated/protected directories, secrets and symlinks; it is not a complete machine/environment snapshot.
External dependencies, ignored files and configuration may change without changing that seal. Record relevant environment details in check summaries.

## Persistence and recovery

State is an atomically replaced, fsynced JSON snapshot in a private directory. File mutation intents are saved before effects.
Each mutation has an operation ID, expected old SHA, intended new SHA, optional backup and status.
After restart a prepared operation is marked applied only if its intended result is present; otherwise it remains uncertain.
No cross-file transaction is claimed. Partial multi-file changes remain inspectable and require local reconciliation.
Events retain the latest 300 entries; turn/checkpoint/operation history remains in the snapshot. There is no automatic compaction or retention deletion.

Before clicking Send, the extension durably records `attempting` in Chrome storage.
Reconciliation checks the existing marker and saved response. A `prepared` journal proves the click was not attempted.
Missing or post-attempt journals without a visible marker are uncertain, including after extension storage loss.
There is deliberately no automatic resend for that state. Exactly-once execution across browser/service crashes is not claimed.

Pause/cancel/native state changes revoke grants. Lost native connectivity fails closed; recovery does not resurrect old tokens.
The daemon and extension serialize or deduplicate work; one workspace session and one in-flight Web request are supported.
An existing composer draft is preserved. User messages are not transformed into local Goal instructions, but share the Web model's context.

## Physical layout

- `src/bridge.ts`: orchestration and durable lifecycle.
- `src/workspace.ts`: text tools and source revision.
- `src/codex.ts`: read-only native protocol adapter.
- `src/http.ts`: public MCP versus private control/extension surfaces.
- `src/extension/`: Chrome worker, visible DOM adapter and popup.
- `src/ui/`: dependency-free local dashboard.
- `plugins/codex-web-goal/`: self-contained stdio MCP plus explicit supervisor skill.
- `test/`: state, permission, transport and synthetic-browser regression tests.

TypeScript is shared across the process boundaries; Zod validates tool inputs. HTTP and WebSocket messages are bounded.
The browser DOM adapter is intentionally isolated: a ChatGPT UI change should require updating one module and its fixtures.
No private backend reverse engineering, session-token proxy or model API emulation is involved.
