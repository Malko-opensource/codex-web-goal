# Verification record — 2026-09-11

This records executed checks, not promises about untested environments.

Environment: macOS arm64, Node 25.6.1, Codex CLI 0.153.4, Playwright 1.63.0 / Chromium 153.0.8010.12.
Node 22.16 is the declared minimum; Linux/Windows and the Node 22 CI matrix have not been executed on this host.

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

The native installation test found that this Codex version does not expand plugin-root placeholders in MCP arguments.
The shipped MCP configuration therefore uses an explicit plugin-relative `cwd` and a relative executable argument.
It also explicitly forwards `WEB_GOAL_STATE_DIR`; the real native-to-bridge call verifies custom state-directory selection.
This is regression-tested rather than inferred from manifest validation.

Not yet verified:

- A real ChatGPT account, today's actual ChatGPT DOM, model compliance with `worker_finish`, and tool confirmations.
- Native `/goal` model-driven automatic continuations across multiple real Web responses or compaction.
- A public HTTPS tunnel round trip, organization data policy, account eligibility or service-policy authorization.
- Chrome Web Store and npm publication. Building release ZIPs does not publish them.

GitHub source publication is separate from a tagged binary release or live-account acceptance.
The initial source publication includes English/Korean setup guides, MIT licensing, third-party notices,
contribution templates and a Node 22 CI matrix. CI results are evidence only after the jobs actually run.

The fixture dashboard screenshot is generated at `test-results/dashboard.png`; it contains only synthetic data.
Follow the account-backed acceptance checklist in [OPERATIONS.md](OPERATIONS.md) before a production release.
