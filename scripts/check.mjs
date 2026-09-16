import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
async function check(root) {
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) await check(file);
    else if (file.endsWith('.mjs')) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  }
}
await check('scripts');
