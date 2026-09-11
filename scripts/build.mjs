import { build } from 'esbuild';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = (...parts) => path.join(root, ...parts);
const project = JSON.parse(await fs.readFile(out('package.json'), 'utf8'));
await fs.mkdir(out('dist', 'ui'), { recursive: true });
await fs.mkdir(out('extension'), { recursive: true });
await fs.mkdir(out('plugins', 'codex-web-goal', 'dist'), { recursive: true });
const builds = await Promise.all([
  build({ entryPoints: [out('src/cli.ts')], outfile: out('dist/cli.js'), bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node22', sourcemap: true }),
  build({ entryPoints: [out('src/plugin-entry.ts')], outfile: out('plugins/codex-web-goal/dist/control-mcp.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', metafile: true }),
  build({ entryPoints: [out('src/ui/app.ts')], outfile: out('dist/ui/app.js'), bundle: true, platform: 'browser', target: 'chrome120' }),
  ...['background', 'content', 'popup'].map(name => build({ entryPoints: [out(`src/extension/${name}.ts`)], outfile: out(`extension/${name}.js`), bundle: true, platform: 'browser', target: 'chrome120', format: name === 'background' ? 'esm' : 'iife' }))
]);
for (const name of ['index.html', 'style.css']) await fs.copyFile(out(`src/ui/${name}`), out(`dist/ui/${name}`));
for (const name of ['popup.html', 'popup.css']) await fs.copyFile(out(`src/extension/${name}`), out(`extension/${name}`));
await fs.copyFile(out('LICENSE'), out('plugins/codex-web-goal/LICENSE'));
await fs.copyFile(out('LICENSE'), out('extension/LICENSE'));
// Preserve the licenses of packages embedded into the self-contained plugin bundle.
const packages = new Map();
for (const input of Object.keys(builds[1].metafile.inputs)) {
  if (!input.includes('node_modules/')) continue;
  let directory = path.dirname(path.resolve(input));
  while (directory !== path.dirname(directory)) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (manifest.name) { packages.set(manifest.name, { directory, manifest }); break; }
    } catch {}
    directory = path.dirname(directory);
  }
}
const notices = ['Bundled third-party licenses for Codex Web Goal.\n'];
for (const [name, { directory, manifest }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  notices.push(`\n${name}@${manifest.version} (${manifest.license ?? 'see license'})\n`);
  const licenses = (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && /^(license|licence|copying|notice)(\.|$)/i.test(entry.name));
  if (!licenses.length) throw new Error(`Missing license text for bundled package ${name}`);
  for (const license of licenses) notices.push(await fs.readFile(path.join(directory, license.name), 'utf8'));
}
await fs.writeFile(out('plugins/codex-web-goal/THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
await fs.writeFile(out('extension/manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Codex Web Goal', version: project.version, minimum_chrome_version: '120',
  description: 'Connect a selected ChatGPT conversation to your local Codex Goal. No cookies or private APIs.',
  permissions: ['storage', 'alarms', 'activeTab'],
  host_permissions: ['http://127.0.0.1/*', 'https://chatgpt.com/*'],
  background: { service_worker: 'background.js', type: 'module' },
  action: { default_popup: 'popup.html', default_title: 'Codex Web Goal' },
  content_scripts: [{ matches: ['https://chatgpt.com/*'], js: ['content.js'], run_at: 'document_idle' }],
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" }
}, null, 2));
await fs.chmod(out('dist/cli.js'), 0o755);
console.log('Built CLI, local dashboard, self-contained Codex plugin and Chrome extension.');
