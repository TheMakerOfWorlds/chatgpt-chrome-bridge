#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { REPOSITORY, sha256, validateBundle, validVersion } from './lib/releases.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || path.join(root, 'dist'));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json')));
const plugin = JSON.parse(await fs.readFile(path.join(root, '.codex-plugin/plugin.json')));
if (!validVersion(pkg.version)) throw new Error('Release requires a stable semantic package version.');
const files = [];
async function add(relative) {
  const target = path.join(root, relative), info = await fs.lstat(target);
  if (info.isSymbolicLink()) throw new Error(`Symlink cannot be released: ${relative}`);
  if (info.isDirectory()) {
    for (const name of (await fs.readdir(target)).sort()) await add(`${relative}/${name}`);
  } else files.push({ path: relative, content: await fs.readFile(target, 'utf8') });
}
// Explicit allowlist: no .git, runtime profiles, credentials, archives, logs,
// dependency trees, personal live-test scripts or workspace verification data.
for (const file of ['package.json','package-lock.json','.codex-plugin/plugin.json','.mcp.json','README.md','LICENSE','install.sh','Setup.command',
  'scripts/lib','scripts/tests','scripts/check.mjs','scripts/mcp-server.mjs','scripts/manage.mjs','scripts/build-release.mjs','skills','docs']) await add(file);
files.sort((a,b) => a.path.localeCompare(b.path));
const data = gzipSync(JSON.stringify({ schema: 1, files }), { level: 9 });
const manifest = { schema: 1, repository: REPOSITORY, version: pkg.version, pluginVersion: plugin.version, minimumNodeMajor: 20,
  asset: 'bridge.bundle.json.gz', sha256: sha256(data), bytes: data.length };
validateBundle(data, manifest);
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, manifest.asset), data);
await fs.writeFile(path.join(output, 'release.json'), JSON.stringify(manifest,null,2)+'\n');
console.log(`Built v${pkg.version}: ${files.length} files, ${data.length} bytes, SHA-256 ${manifest.sha256}`);
