import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { controlTools, mcpServer } from './tools.js';
import type { Bridge } from './bridge.js';

export const defaultStateDirectory = () => process.env.WEB_GOAL_STATE_DIR ?? path.join(os.homedir(), '.local', 'share', 'codex-web-goal');
export async function controlClient(directory = defaultStateDirectory()) {
  const [state, runtime] = await Promise.all([
    fs.readFile(path.join(directory, 'state.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(directory, 'runtime.json'), 'utf8').then(JSON.parse)
  ]);
  return { runtime, async call(name: string, input: unknown = {}) {
    const response = await fetch(`http://127.0.0.1:${runtime.controlPort}/api/tools/${name}`, {
      method: 'POST', headers: { authorization: `Bearer ${state.controlToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(input), signal: AbortSignal.timeout(40_000)
    });
    const result = await response.json() as { error?: { code: string; message: string } };
    if (!response.ok) throw new Error(`${result.error?.code}: ${result.error?.message}`);
    return result;
  } };
}
export async function runControlMcp(directory = defaultStateDirectory()) {
  // Reuse the schema catalog, replacing all handlers before registering any tool.
  const specs = controlTools({} as Bridge).map(spec => ({ ...spec, execute: async (input: unknown) => {
    const client = await controlClient(directory); return client.call(spec.name, spec.schema.parse(input));
  } }));
  await mcpServer(specs, 'codex-web-goal-control').connect(new StdioServerTransport());
}
