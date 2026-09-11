import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
// ZIP store method, portable and dependency-free; generated files only.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const table = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc(bytes) { let value = 0xffffffff; for (const byte of bytes) value = table[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
async function zip(directory, destination) {
  const entries = [];
  async function walk(dir, prefix = '') { for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) await walk(path.join(dir, entry.name), prefix + entry.name + '/');
    else entries.push({ name: Buffer.from(prefix + entry.name), bytes: await fs.readFile(path.join(dir, entry.name)) });
  } }
  await walk(directory); const local = [], central = []; let offset = 0;
  for (const { name, bytes } of entries) {
    const checksum = crc(bytes), header = Buffer.alloc(30), index = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt16LE(0x800,6); header.writeUInt16LE(33,12); header.writeUInt32LE(checksum,14); header.writeUInt32LE(bytes.length,18); header.writeUInt32LE(bytes.length,22); header.writeUInt16LE(name.length,26);
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20,4); index.writeUInt16LE(20,6); index.writeUInt16LE(0x800,8); index.writeUInt16LE(33,14); index.writeUInt32LE(checksum,16); index.writeUInt32LE(bytes.length,20); index.writeUInt32LE(bytes.length,24); index.writeUInt16LE(name.length,28); index.writeUInt32LE(offset,42);
    local.push(header,name,bytes); central.push(index,name); offset += header.length + name.length + bytes.length;
  }
  const centralBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(centralBytes.length,12); end.writeUInt32LE(offset,16);
  await fs.writeFile(destination, Buffer.concat([...local,centralBytes,end]));
}
await fs.mkdir(path.join(root, 'release'), { recursive: true });
const checksums = [];
for (const [source, name] of [['extension','codex-web-goal-chrome-0.1.0.zip'],['plugins/codex-web-goal','codex-web-goal-plugin-0.1.0.zip']]) {
  const destination = path.join(root,'release',name); await zip(path.join(root,source),destination);
  checksums.push(createHash('sha256').update(await fs.readFile(destination)).digest('hex') + '  ' + name);
}
await fs.writeFile(path.join(root,'release/SHA256SUMS'), checksums.join('\n')+'\n');
console.log('Created Chrome and Codex plugin ZIPs plus SHA256SUMS in release/. Nothing was published.');
