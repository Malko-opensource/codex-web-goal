import { runControlMcp } from './control-mcp.js';
void runControlMcp().catch(error => { console.error(String(error)); process.exitCode = 1; });
