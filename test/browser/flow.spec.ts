import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture } from '../helpers.js';
import { serve } from '../../src/http.js';
import { Bridge } from '../../src/bridge.js';
import { FakeHost, FakeRunner } from '../execution-helpers.js';
import { executionPolicySchema } from '../../src/execution-contract.js';

// Nothing from chatgpt.com is loaded: all navigation is fulfilled by this local fixture.
const html = `<!doctype html><html><body><main id="messages"></main><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button>
<script>
window.sends=0;
function message(role,text){const node=document.createElement('div');node.dataset.messageAuthorRole=role;node.textContent=text;document.querySelector('#messages').append(node);return node;}
document.querySelector('button').onclick=async()=>{
 const text=document.querySelector('textarea').value;if(!text)return;
 window.sends++;message('user',text);document.querySelector('textarea').value='';
 const stop=document.createElement('button');stop.dataset.testid='stop-button';document.body.append(stop);
 try{await window.performWorker(text);const node=message('assistant','');node.innerHTML='<div class="markdown"><p>Implemented and handed off.</p><pre><code class="language-js">add(2,3) === 5</code></pre></div>';}catch(error){message('assistant',String(error));}
 stop.remove();
};
</script></body></html>`;

async function extensionContext(directory: string) {
  const extension = path.resolve('extension');
  return chromium.launchPersistentContext(path.join(directory, 'chrome'), {
    headless: true, channel: 'chromium', viewport: { width: 1440, height: 1100 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
}
async function installAndPair(context: BrowserContext, base: string, code: string) {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const result = await popup.evaluate(async ({ base, code }) => chrome.runtime.sendMessage({ type: 'pair', base, code }), { base, code });
  expect(result).toEqual({ ok: true });
  await expect.poll(() => popup.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'status' })).connectionStatus)).toBe('Connected');
  return popup;
}
async function bind(popup: Page, chat: Page) {
  await chat.bringToFront();
  const result = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'bind_active' }));
  expect(result).toEqual({ ok: true });
}

test('ordinary request uses shared control tools and returns an answer without creating a Goal', async () => {
  const f = await fixture(); await f.bridge.shutdown(); f.native.thread.goal = null;
  const host = new FakeHost(), bridge = new Bridge(f.store, f.workspace, f.native, { host }); await bridge.recover();
  const servers = await serve(bridge, { mcpPort: 0, controlPort: 0, uiDirectory: path.resolve('dist/ui') });
  const context = await extensionContext(f.directory), mcp = new Client({ name: 'ordinary-worker-fixture', version: '1' });
  try {
    const local = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${servers.controlPort}/api/tools/${name}`, { method: 'POST', headers: { authorization: `Bearer ${f.store.state.controlToken}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
      expect(response.status).toBe(200); return response.json();
    };
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${servers.mcpPort}/mcp/${f.store.state.mcpToken}`)));
    const call = async (name: string, args: Record<string, unknown>) => { const result = await mcp.callTool({ name, arguments: args }); expect(result.isError).toBeFalsy(); return JSON.parse((result.content as { text: string }[])[0]!.text); };
    await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    const chat = await context.newPage();
    await chat.exposeFunction('performWorker', async (prompt: string) => {
      const turn_token = /turn_token=([\w-]+)/.exec(prompt)![1];
      const canonical = await call('worker_context', { turn_token });
      expect(canonical.policy.resultKind).toBe('answer');
      await call('worker_context', { turn_token, acknowledge_digest: canonical.context.digest });
      expect(host.modelRequests).toBe(0);
      await call('worker_finish', { turn_token, context_version: canonical.context.version, policy_version: canonical.policy.version, summary: 'Analysis returned to the originating request', evidence: ['Synthetic source'], unresolved: [] });
    });
    await chat.goto('https://chatgpt.com/c/ordinary-fixture');
    const popup = await installAndPair(context, `http://127.0.0.1:${servers.controlPort}`, (await bridge.pairCode()).code); await bind(popup, chat);
    await local('delegation_open', { kind: 'request', thread_id: f.native.thread.id, origin_request_id: 'ordinary-origin', input_version: 1, objective: 'Analyze a normal request', policy: { mode: 'web-controlled', network: 'public-internet', resultKind: 'answer' } });
    await local('delegation_dispatch', { request_id: 'ordinary-part', task: 'Analyze', criteria: 'Return a useful answer' });
    await expect.poll(() => bridge.turn?.status, { timeout: 15000 }).toBe('checked'); await expect.poll(() => host.modelRequests).toBe(1);
    const result = await local('delegation_result', { turn_id: bridge.turn!.id }); expect(result.result.kind).toBe('answer');
    expect(f.native.thread.goal).toBeNull(); expect(host.lease!.origin!.requestId).toBe('ordinary-origin');
    expect(await chat.evaluate(() => (window as unknown as { sends: number }).sends)).toBe(1);
  } finally { await context.close(); await mcp.close(); await servers.close(); await bridge.shutdown(); await f.cleanup(); }
});

test('Web-controlled MCP edit/verify/retry/finish wakes a synthetic host only once', async () => {
  const f = await fixture(); await f.bridge.shutdown();
  await fs.writeFile(path.join(f.root, 'check.cjs'), 'immutable synthetic checker');
  await fs.writeFile(path.join(f.root, 'result.txt'), 'initial');
  const host = new FakeHost(), runner = new FakeRunner();
  const bridge = new Bridge(f.store, f.workspace, f.native, { host, runner }); await bridge.recover();
  const servers = await serve(bridge, { mcpPort: 0, controlPort: 0, uiDirectory: path.resolve('dist/ui') });
  const context = await extensionContext(f.directory);
  const mcp = new Client({ name: 'synthetic-execution-worker', version: '1' });
  try {
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${servers.mcpPort}/mcp/${f.store.state.mcpToken}`)));
    const call = async (name: string, args: Record<string, unknown>) => { const result = await mcp.callTool({ name, arguments: args }); expect(result.isError).toBeFalsy(); return JSON.parse((result.content as { text: string }[])[0]!.text); };
    await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    const chat = await context.newPage();
    await chat.exposeFunction('performWorker', async (prompt: string) => {
      const turn_token = /turn_token=([\w-]+)/.exec(prompt)![1];
      const canonical = await call('worker_context', { turn_token });
      await call('worker_context', { turn_token, acknowledge_digest: canonical.context.digest });
      const grant = { turn_token, context_version: canonical.context.version, policy_version: canonical.policy.version };
      runner.exitCode = 1;
      const failed = await call('workspace_verify', { ...grant, request_id: 'first-check' });
      await expect.poll(async () => (await call('workspace_job_result', { run_id: failed.run_id })).status).toBe('failed');
      expect(host.modelRequests).toBe(0);
      await call('workspace_write', { ...grant, operation_id: randomUUID(), path: 'result.txt', expected_sha256: (await f.workspace.read('result.txt')).sha256, content: 'fixed' });
      runner.exitCode = 0;
      const passed = await call('workspace_verify', { ...grant, request_id: 'second-check' });
      await expect.poll(async () => (await call('workspace_job_result', { run_id: passed.run_id })).status).toBe('passed');
      expect(host.modelRequests).toBe(0);
      await call('worker_finish', { ...grant, run_id: passed.run_id, summary: 'Verified by runner' });
    });
    await chat.goto('https://chatgpt.com/c/fixture-chat');
    const popup = await installAndPair(context, `http://127.0.0.1:${servers.controlPort}`, (await bridge.pairCode()).code);
    await bind(popup, chat); await expect.poll(() => Boolean(f.store.state.chat)).toBe(true);
    await bridge.open('goal', undefined, executionPolicySchema.parse({ mode: 'web-controlled', network: 'public-internet', checks: [{ id: 'required', argv: ['node', 'check.cjs'] }], protectedFiles: ['check.cjs'], expectedFiles: ['result.txt'] }));
    await bridge.dispatch({ requestId: 'web-controlled-browser', task: 'Fix result', context: 'Explicit fixture context', criteria: 'Fixed and verified' });
    await expect.poll(() => bridge.turn?.status, { timeout: 15_000 }).toBe('checked');
    await expect.poll(() => host.modelRequests).toBe(1);
    await bridge.pump(); expect(host.modelRequests).toBe(1);
    expect(runner.executions).toBe(2); expect(await chat.evaluate(() => (window as unknown as { sends: number }).sends)).toBe(1);
    expect(f.native.thread.goal!.status).toBe('active');
  } finally { await context.close(); await mcp.close(); await servers.close(); await bridge.shutdown(); await f.cleanup(); }
});

test('Chrome extension + actual MCP + three local verification cycles + reconnect + manual chat', async () => {
  const f = await fixture(); const servers = await serve(f.bridge, { mcpPort: 0, controlPort: 0, uiDirectory: path.resolve('dist/ui') });
  const context = await extensionContext(f.directory);
  const mcp = new Client({ name: 'synthetic-web-worker', version: '1' });
  try {
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${servers.mcpPort}/mcp/${f.store.state.mcpToken}`)));
    const call = async (name: string, args: Record<string, unknown>) => { const result = await mcp.callTool({ name, arguments: args }); expect(result.isError).toBeFalsy(); return JSON.parse((result.content as { text: string }[])[0]!.text); };
    await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    const chat = await context.newPage();
    let cycle = 0;
    await chat.exposeFunction('performWorker', async (prompt: string) => {
      const turn_token = /turn_token=([\w-]+)/.exec(prompt)![1]; cycle++;
      await call('worker_context', { turn_token });
      const before = await f.workspace.current('math.cjs');
      await call('workspace_write', { operation_id: randomUUID(), path: 'math.cjs', expected_sha256: before.sha256, turn_token, content: `exports.add=(a,b)=>a+b; // cycle ${cycle}\n` });
      await call('worker_finish', { turn_token, summary: `Completed cycle ${cycle}` });
    });
    await chat.goto('https://chatgpt.com/c/fixture-chat');
    const popup = await installAndPair(context, `http://127.0.0.1:${servers.controlPort}`, (await f.bridge.pairCode()).code);
    await bind(popup, chat); await expect.poll(() => f.bridge.state.chat?.url).toBe('https://chatgpt.com/c/fixture-chat');
    await f.bridge.open('goal');
    for (let i = 1; i <= 3; i++) {
      const turn = await f.bridge.dispatch({ requestId: `cycle-${i}`, task: 'Implement addition', context: `Cycle ${i}`, criteria: '2 + 3 = 5' });
      if (i === 2) {
        await expect.poll(() => f.bridge.turn!.workerFinished).toBe(true);
        await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'reconnect' }));
      }
      await expect.poll(() => f.bridge.turn?.status, { timeout: 15_000 }).toBe('answered');
      expect(f.bridge.turn?.id).toBe(turn.id); expect(f.bridge.turn!.response).toContain('```js');
      const seal = await f.bridge.seal();
      const output = execFileSync(process.execPath, ['-e', "const assert=require('node:assert/strict');assert.equal(require('./math.cjs').add(2,3),5);console.log('pass')"], { cwd: f.root, encoding: 'utf8' });
      await f.bridge.checkpoint({ revision: seal.revision, verdict: 'pass', summary: 'Local execution passed', checks: [{ command: 'node -e assert(add(2,3)===5)', exitCode: 0, summary: output.trim() }] });
      if (i === 1) {
        await chat.evaluate(() => {
          for (const [role, text] of [['user', 'Manual question unrelated to the goal'], ['assistant', 'Manual answer']]) {
            const div = document.createElement('div'); div.dataset.messageAuthorRole = role; div.textContent = text!; document.querySelector('#messages')!.append(div);
          }
        });
      }
    }
    expect(await chat.evaluate(() => (window as unknown as { sends: number }).sends)).toBe(3);
    expect(f.native.thread.goal!.status).toBe('active');
    expect(f.bridge.view().turns).toHaveLength(3);
    const dashboard = await context.newPage();
    await dashboard.goto(`http://127.0.0.1:${servers.controlPort}/#${f.store.state.controlToken}`);
    await expect(dashboard.locator('#turn-state')).toHaveText('#3 · 로컬 검증됨');
    await expect(dashboard.locator('#turn-detail')).toContainText('전달 answered · 작업 worker_finished · 검증 locally_validated');
    await expect(dashboard.locator('#connection-status')).toHaveText('● Chrome connected');
    await expect(dashboard.locator('#error')).toBeHidden();
    await dashboard.screenshot({ path: 'test-results/dashboard.png', fullPage: true });
  } finally { await context.close(); await mcp.close(); await servers.close(); await f.cleanup(); }
});

test('an ambiguous send survives reload without submitting the same prompt again', async () => {
  const f = await fixture(); const servers = await serve(f.bridge, { mcpPort: 0, controlPort: 0, uiDirectory: path.resolve('dist/ui') });
  const context = await extensionContext(f.directory);
  try {
    const ambiguous = '<html><textarea id="prompt-textarea"></textarea><button data-testid="send-button" onclick="localStorage.attempts=String(Number(localStorage.attempts||0)+1); document.querySelector(\'textarea\').value=\'\'">Send</button></html>';
    await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: ambiguous }));
    const chat = await context.newPage(); await chat.goto('https://chatgpt.com/c/fixture-chat');
    const popup = await installAndPair(context, `http://127.0.0.1:${servers.controlPort}`, (await f.bridge.pairCode()).code);
    await bind(popup, chat); await expect.poll(() => Boolean(f.bridge.state.chat)).toBe(true); await f.bridge.open('goal');
    await f.bridge.dispatch({ requestId: 'ambiguous', task: 'Do work', context: '', criteria: 'Done' });
    await expect.poll(() => f.bridge.turn?.status, { timeout: 10_000 }).toBe('uncertain');
    expect(await chat.evaluate(() => localStorage.attempts)).toBe('1');
    await chat.reload(); await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'reconnect' }));
    await expect.poll(() => f.bridge.state.events.filter(x => x.kind === 'turn_uncertain').length, { timeout: 10_000 }).toBeGreaterThan(1);
    expect(await chat.evaluate(() => localStorage.attempts)).toBe('1');
  } finally { await context.close(); await servers.close(); await f.cleanup(); }
});

test('the saved conversation rebinds by URL after the extension socket and tab are replaced', async () => {
  const f = await fixture(); const servers = await serve(f.bridge, { mcpPort: 0, controlPort: 0, uiDirectory: path.resolve('dist/ui') });
  const context = await extensionContext(f.directory);
  try {
    await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    const chat = await context.newPage(); await chat.goto('https://chatgpt.com/c/fixture-chat');
    const popup = await installAndPair(context, `http://127.0.0.1:${servers.controlPort}`, (await f.bridge.pairCode()).code);
    await bind(popup, chat); const oldTabId = f.bridge.state.chat!.tabId;
    f.bridge.conversation?.close(); await expect.poll(() => f.bridge.view().conversationConnected).toBe(false);
    await chat.close();
    const reopened = await context.newPage(); await reopened.goto('https://chatgpt.com/c/fixture-chat');
    await expect.poll(() => f.bridge.view().conversationConnected, { timeout: 10_000 }).toBe(true);
    await expect.poll(() => f.bridge.state.chat?.tabId, { timeout: 10_000 }).not.toBe(oldTabId);
    expect(f.bridge.state.chat?.url).toBe('https://chatgpt.com/c/fixture-chat');
  } finally { await context.close(); await servers.close(); await f.cleanup(); }
});

test('a contenteditable manual draft is preserved until the user clears it', async () => {
  const f = await fixture(); const servers = await serve(f.bridge, { mcpPort: 0, controlPort: 0, uiDirectory: path.resolve('dist/ui') });
  const context = await extensionContext(f.directory);
  try {
    const editable = html.replace('<textarea id="prompt-textarea"></textarea>', '<div id="prompt-textarea" contenteditable="true"></div>')
      .replaceAll("document.querySelector('textarea').value", "document.querySelector('#prompt-textarea').innerText");
    await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: editable }));
    const chat = await context.newPage(); await chat.exposeFunction('performWorker', async () => {}); await chat.goto('https://chatgpt.com/c/fixture-chat');
    await chat.locator('#prompt-textarea').fill('My unfinished manual draft');
    const popup = await installAndPair(context, `http://127.0.0.1:${servers.controlPort}`, (await f.bridge.pairCode()).code);
    await bind(popup, chat); await expect.poll(() => Boolean(f.bridge.state.chat)).toBe(true); await f.bridge.open('plan');
    await f.bridge.dispatch({ requestId: 'draft', task: 'Plan', context: '', criteria: 'Review' });
    await expect.poll(() => f.bridge.turn?.status).toBe('dispatching');
    await expect(chat.locator('#prompt-textarea')).toHaveText('My unfinished manual draft');
    expect(await chat.evaluate(() => (window as unknown as { sends: number }).sends)).toBe(0);
    await chat.locator('#prompt-textarea').fill('');
    await expect.poll(() => chat.evaluate(() => (window as unknown as { sends: number }).sends)).toBe(1);
  } finally { await context.close(); await servers.close(); await f.cleanup(); }
});
