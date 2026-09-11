# Verification record — 2026-09-11

This records executed checks, not promises about untested environments.

Environment: macOS arm64, Node 25.6.1, Codex CLI 0.153.4, Playwright 1.63.0 / Chromium 153.0.8010.12.
Node 22.16 is the declared minimum. Hosted Node 22 checks are recorded separately below; they are not local-host results.

| Executed check | Result |
| --- | --- |
| TypeScript strict check and all bundles | Passed |
| `npm test` | 15 passed; no skipped tests |
| `npm run test:browser` | 3 passed with the actual extension and local MCP |
| Three synthetic Web/local cycles | File edits, real local Node execution and checkpoints passed |
| Reconnect / ambiguous-send reload | No duplicate automatic submission |
| Manual chat / contenteditable draft | Manual message excluded from local turn capture; draft preserved |
| Native Codex integration | Isolated plugin install → ephemeral native thread → MCP discovery → actual bridge status call passed |
| Native Goal protocol | Installed schema and explicit ephemeral-thread rejection verified; no goal or model turn created |
| Official plugin/skill validators | Passed |
| Dependency audit after esbuild update | 0 known vulnerabilities reported by npm at installation time |
| Chrome and plugin ZIPs | Generated; ZIP integrity checked |
| npm package file-list inspection | Passed; no state, credentials or tests included |
| Clean source export | `npm ci`, all 15 Node tests and release build passed with only publication-selected source |
| Publication source inspection | Extension sources included; generated output/state excluded; checked credential and private-path patterns had no findings |
| Git marketplace package | Clean remote registration exposed the catalog, but v0.1.0 omitted the generated MCP bundle; v0.1.1 tracks and checks it before tests |

The native installation test found that this Codex version does not expand plugin-root placeholders in MCP arguments.
The shipped MCP configuration therefore uses an explicit plugin-relative `cwd` and a relative executable argument.
It also explicitly forwards `WEB_GOAL_STATE_DIR`; the real native-to-bridge call verifies custom state-directory selection.
This is regression-tested rather than inferred from manifest validation.

Not yet verified:

- A real ChatGPT account, today's actual ChatGPT DOM, model compliance with `worker_finish`, and tool confirmations.
- Native `/goal` model-driven automatic continuations across multiple real Web responses or compaction.
- A public HTTPS tunnel round trip, organization data policy, account eligibility or service-policy authorization.
- Chrome Web Store and npm publication. Building release ZIPs does not publish them.

## User-reported live-account observation — 2026-09-11

This is operational evidence reported from a real connection, not a result reproduced by the automated suite. The session
observed that a closed/reloaded tab could require rebinding; ambiguous submission required separate conversation inspection;
the rendered composer required the actual Send button; bridge `submitted` and a stale local TUI conclusion could disagree;
approvals could reappear; MCP connection alone did not prove the read/write/`worker_finish` path; browser inspection could
surface sensitive one-time values; and `submitted` did not imply the expected document directory existed.

The URL-based rebind path now has a synthetic regression for simultaneous extension-socket and tab replacement. Real-account
revalidation, sensitive accessibility-output redaction and a non-visible per-turn authorization channel remain unverified.

GitHub source publication is separate from a tagged binary release or live-account acceptance.
The initial source publication includes English/Korean setup guides, MIT licensing, third-party notices,
contribution templates and a Node 22 CI matrix. CI results are evidence only after the jobs actually run.

## Initial GitHub CI

[The first source-publication run](https://github.com/Malko-opensource/codex-web-goal/actions/runs/34560849477)
passed on Linux (including all three synthetic browser tests) and macOS. Windows passed 14 of 15 Node tests;
the native sidecar test incorrectly used the POSIX-only `/fixture` string as its expected absolute workspace.
The fixture now uses `path.resolve` on every platform and also checks that another workspace is excluded.
Windows acceptance depends on the follow-up CI result, not this fixture correction alone.

## External marketplace packaging

The v0.1.0 catalog and plugin manifests were valid, but the repository ignored
`plugins/codex-web-goal/dist/control-mcp.cjs`. A clean Git marketplace could therefore register and
select the plugin while installing no executable MCP bundle. Version 0.1.1 includes that self-contained bundle,
checks all required distribution files before tests, and fails CI if a rebuild changes the committed bundle.
The external installation is accepted only after a clean remote marketplace install and actual MCP call both pass.

The fixture dashboard screenshot is generated at `test-results/dashboard.png`; it contains only synthetic data.
Follow the account-backed acceptance checklist in [OPERATIONS.md](OPERATIONS.md) before a production release.

## Web-controlled execution implementation — 2026-09-11

The following local results supersede the earlier test counts, not the historical integration claims above.
The mode is opt-in; existing direct sessions and local verification remain unchanged.

| Executed check | Result |
| --- | --- |
| `npm test` (includes strict TypeScript check and build) | 32 passed, 0 failed; 2 opt-in native sandbox tests skipped |
| `npm run test:browser` | 5 passed with synthetic conversations, the real extension and local MCP transport |
| `WEB_GOAL_SANDBOX_TESTS=1 WEB_GOAL_CANARY=not-a-secret node --import tsx --test test/runner.test.ts` | 5 passed, including both actual macOS sandbox tests |
| Official skill `quick_validate.py` | Passed for `plugins/codex-web-goal/skills/web-goal` |

Coverage includes context acknowledgement and stale-version rejection, immutable checker paths, execution request
idempotency, failed-check/edit/recheck loops, revision drift, verification-budget exhaustion, user-pause cancellation,
post-seal drift, durable wake receipts after restart, and private host-socket contract validation. Browser tests cover
replacement/reconnection and a complete synthetic Web-driven edit/verify/finish cycle without duplicate submission.
Native canaries demonstrate blocked live-file reads/writes, absent inherited credentials, rejected direct loopback and
private proxy destinations, immutable checker files (including deletion and parent-directory rename attempts), and use
of an inherited, reserved local-service listener by the sandbox and a child process.

Remaining acceptance gaps:

- The host in these integration tests is a synthetic scheduler. Its zero normal-progress model-request count and
  exactly-once wake count do **not** establish those properties in stock Codex. The real host scheduler implementation
  is outside this repository; without the custom host contract, Web-controlled execution fails closed.
- Cancellation/watchdog tests do not establish containment of hostile descendants that deliberately escape their
  process group. This mode is not accepted for hostile-code production use.
- Public-address classification and private-egress rejection passed, but an actual public-internet round trip,
  public tunnel and organization source-export policy have not been accepted here.
- Real ChatGPT account/DOM behavior, a real in-app browser adapter, non-visible turn authorization, and comprehensive
  screenshot/accessibility redaction remain unverified or unimplemented.
- No remote CI, publication, commit or push was performed for this implementation.

See [the execution contract and rollout limits](web-goal/web-controlled-execution.md) before enabling the new mode.

## Shared ordinary-request / Goal delegation — 2026-09-11

This subsequent implementation adds a common delegation runtime without removing the legacy direct/Goal paths.

| Executed check | Result |
| --- | --- |
| `npm test` (strict TypeScript, distribution check, build, Node tests) | 42 passed, 0 failed; 2 opt-in native tests skipped |
| `npm run test:browser` | 6 passed, including ordinary request dispatch and answer return without any Goal |
| Opt-in macOS runner suite | 5 passed, including the 2 actual native sandbox cases |
| Official skill validator | Passed |
| `git diff --check` | Passed |

New coverage includes exact originating request/input-version binding, old-host rejection, answer-only read-only
behavior, file-only read-back without invented runner evidence, bounded local assistance/fresh-context resume,
late-return cancellation, actual MCP image content, selected skill/hash boundaries, dashboard-authenticated external
MCP approval, deduplicated calls, uncertain-outcome escalation without replay, and v2-to-v3 backup migration.
Result retrieval also detects source drift after a wake was already accepted.

The ordinary-request and local-assistance scheduler is still synthetic. Real host request identity, automatic return
to the original Codex conversation, zero-model waiting, and per-task usage accounting remain unverified/unsupported
without an actual host implementation. Images are delivered as MCP content; browser attachment upload, real ChatGPT
vision behavior, automatic export of Codex attachments, and universal plugin/stdio relay are not implemented here.
Configured MCP services enforce their own execution/authorization boundary, not the Mac sandbox. Existing hostile
process containment and token-exposure limitations above remain. No real user account, production MCP service, commit,
push or publication was used for these tests.
