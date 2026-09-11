# Codex Web Goal

English · [한국어](README.ko.md)

**Web authors. Verification is explicit and evidence-bound.**

The default remains local-supervised. An opt-in **web-controlled** protocol adds versioned context,
Mac sandbox execution, iterative verification and a private host-wait adapter. **Stock Codex host
scheduler integration is not supplied by this repository**: configuring a supported host is required;
without it the mode fails closed. Synthetic zero-wake tests are not proof of real Codex zero-model waiting.
See [implementation and host requirements](docs/web-goal/web-controlled-execution.md).

The [shared delegation layer](docs/web-goal/shared-delegation.md) also supports ordinary requests without
creating a Goal: task-specific result contracts, selected skill/image resources, approval-gated MCP tools,
and bounded local assistance. Actual return-to-conversation scheduling requires the host integration above.

Connect a real ChatGPT Web conversation to a local Codex native `/goal`.
Local Codex owns the objective, sends the next task and verification feedback to Web,
runs the code locally, and decides whether the goal is complete.

> **Experimental.** Synthetic browser tests and native Codex protocol integration have passed.
> A real ChatGPT account and model-driven native Goal continuations have **not** been tested end to end.
> See the [verification record](docs/VERIFICATION.md) before relying on this with a real repository.

```text
You → local Codex /goal → bridge → Chrome extension → ChatGPT Web
          ↑                 ↑                             │
          │                 └── scoped MCP file tools ─────┘
          └── local execution → verification → next Web task
```

This is an independent TypeScript project, not a ChatGPT API proxy or an adapter of another repository.
GitHub and GitLab are not part of the task-delivery path. Point the bridge at your local clone,
including an on-premises GitLab clone accessed over VPN. No commit, push, PR or MR is required or created automatically.

## What is included

- **Native Goal supervision:** local Codex dispatches Web turns, checks progress, and owns completion.
- **Web workspace tools:** scoped file reading, search, writing, exact edits and deletion with SHA checks and backups.
- **Plan sessions:** server-enforced read-only file access and no Web command execution.
- **Chrome MV3 extension:** visible DOM interaction with one selected chat; no cookies or private ChatGPT APIs.
- **Local dashboard:** connection status, turns, responses, pause/stop and per-command approvals in direct mode.
- **Recovery:** persisted operation IDs, dispatch journal, evidence and reconnection. Ambiguous sends are not blindly retried.
- **Codex plugin and `$web-goal` skill**, extension ZIP packaging, tests and GitHub Actions checks.

## Requirements and support boundary

- Node.js **22.16+**, npm and Chrome.
- Codex CLI with native `/goal`, `--remote` and App Server Goal methods. Protocol checked against **0.153.4**.
- A ChatGPT account/workspace that permits custom MCP connections.
- ngrok or another HTTPS tunnel for the MCP listener only.
- Permission to send the selected source and logs to ChatGPT and your tunnel provider.

The supported entry point is **Codex CLI connected to the App Server started by this project**.
Attaching automatically to an already-open Codex Desktop task is not supported.
The Codex in-app browser can display the local dashboard beside the task, but it does not replace the
Chrome work tab because this release depends on a Chrome MV3 extension and content script.
One bridge instance handles one developer, workspace, session and selected Web conversation.
Separate instances need distinct state directories, bridge ports and App Server addresses.

## Quick start

### 1. Install the Codex plugin

For a normal external installation, add this GitHub repository as a marketplace and install the plugin:

```sh
codex plugin marketplace add Malko-opensource/codex-web-goal --ref main
codex plugin add codex-web-goal@codex-web-goal
```

The marketplace manifest is `.agents/plugins/marketplace.json`; it resolves the plugin manifest at
`plugins/codex-web-goal/.codex-plugin/plugin.json`. The repository includes the self-contained MCP bundle,
so marketplace installation does not run npm or build untrusted source. Restart Codex after installation.

You still need the local bridge CLI. Until an npm package is published, clone and build it:

```sh
git clone https://github.com/Malko-opensource/codex-web-goal.git
cd codex-web-goal
npm ci
npm run build
node dist/cli.js install-plugin
```

`install-plugin` switches your installation to this local checkout, which is useful while developing.
Review the plugin and skill first. Building alone does not modify Codex settings; re-register if you move the checkout.
No npm or Chrome Web Store package is published.

### 2. Start the local bridge

```sh
node dist/cli.js start --workspace /absolute/path/to/your/repo
```

Open the printed Dashboard URL.

| Default port | Purpose | Exposure |
| --- | --- | --- |
| 43120 | ChatGPT MCP | This port only, through HTTPS |
| 43121 | Dashboard, extension and local control | Never tunnel |
| 43122 | Native Codex App Server | Never tunnel |

State defaults to `~/.local/share/codex-web-goal`. For custom state, pass the same
`--state-dir /absolute/private/dir` to every CLI command. Keep it outside the repository or inside `.web-goal/`.
State contains tokens and source backups; never share or commit it.

### 3. Connect ChatGPT to MCP

In another terminal:

```sh
ngrok http 43120
```

Enable ChatGPT developer mode and add a custom MCP connection. Append the printed
`/mcp/<secret-token>` path to the tunnel's HTTPS origin, for example
`https://your-tunnel.example/mcp/<token>`. This bridge has no OAuth server: the URL token is the credential.

Select that connection in a new ChatGPT chat and send an initial message so the chat has a `/c/...` URL.
Ask it to call `workspace_info` and `workspace_list` and verify the selected repository.
Menu names and availability depend on account/workspace policy; consult
[OpenAI's connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).
Handle login, tool confirmations, security prompts and usage limits yourself. None are bypassed.

### 4. Pair the Chrome extension

1. Open `chrome://extensions`, enable developer mode and load the generated `extension/` folder unpacked.
2. Generate a pairing code in the local dashboard. It expires after five minutes and is single-use.
3. Enter `http://127.0.0.1:43121` and the code in the extension popup.
4. Activate your ChatGPT conversation tab and select **이 채팅 연결 (Connect this chat)** in the extension.
5. Check the connection and chat URL in the dashboard. You cannot change chats during a Goal.

### 5. Start a real local Goal

```sh
node dist/cli.js codex
```

Inside the opened **Codex terminal**, not your shell:

```text
/goal $web-goal Fix the login bug and keep going until the relevant tests pass.
Use the connected ChatGPT Web conversation for design, documentation and code.
Execute and verify locally.
```

If your Codex version does not accept the combined syntax, set the native goal with `/goal`, then invoke
`$web-goal` explicitly. The bridge never declares the native goal complete on Codex's behalf.
For design-only work, use Codex Plan mode with `$web-goal`. End the read-only bridge session before
binding an implementation Goal with explicit implementation approval.

## Direct Web work and recovery

For file work without a Goal, start with `--no-codex`. The extension is only required for automatic
Goal message round trips. Direct-mode commands require approval of the exact command and working directory
in the dashboard. Approved commands run as your OS user, **not inside Codex's sandbox**.

```sh
node dist/cli.js status
node dist/cli.js doctor
node dist/cli.js codex --thread-id <existing-native-thread-id>
```

Pause/stop revokes Web editing access but does not undo applied changes. Stopping the bridge also stops its
owned App Server. Reopen the existing native task after restarting. Goal changes, failed Goal lookups or uncertain
delivery stop progress for local review; resuming does not revive old write tokens.
Manual messages in the selected Web chat are not collected as local Goal instructions, but they **share the Web model's context**.

Read [operations and recovery](docs/OPERATIONS.md), [architecture](docs/ARCHITECTURE.md),
[expanded Korean operational design](docs/web-goal/README.md), [security boundaries](SECURITY.md) and [contributing](CONTRIBUTING.md).

## Development

```sh
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run test:codex
npm run release
```

Browser tests use the real extension and local MCP with a synthetic ChatGPT page, not a real account or model.
The native Codex test also runs without a model turn. `release/` receives Chrome/plugin ZIPs and `SHA256SUMS`;
these commands do not publish anything. TypeScript keeps the extension, MCP and dashboard contracts together,
without Electron or a separate database server.

## License and affiliation

[MIT](LICENSE). Independently authored; implementation was not copied from the reference projects.
Bundled dependencies retain their own licenses, included in the generated plugin's third-party notices.
Not affiliated with or endorsed by OpenAI, GitHub, GitLab or ngrok.
