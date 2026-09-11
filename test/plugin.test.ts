import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture } from './helpers.js';
import { serve } from '../src/http.js';

test('built self-contained plugin serves local control MCP through stdio', async t => {
  const f = await fixture(); const servers = await serve(f.bridge, { mcpPort: 0, controlPort: 0, uiDirectory: path.resolve('dist/ui') });
  await fs.writeFile(path.join(f.store.directory, 'runtime.json'), JSON.stringify({ controlPort: servers.controlPort }));
  const client = new Client({ name: 'plugin-test', version: '1' });
  t.after(async () => { await client.close(); await servers.close(); await f.cleanup(); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('plugins/codex-web-goal/dist/control-mcp.cjs')], env: { ...process.env as Record<string, string>, WEB_GOAL_STATE_DIR: f.store.directory }, stderr: 'pipe' }));
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'web_goal_dispatch'));
  const result = await client.callTool({ name: 'web_goal_status', arguments: {} });
  assert.ok(!result.isError); const state = JSON.parse((result.content as { text: string }[])[0]!.text);
  assert.equal(state.workspace, f.root); assert.equal(state.browserConnected, false);
});
