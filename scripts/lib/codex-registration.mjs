import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Use Codex's configuration API to disable the superseded personal install.
// Uninstall would delete cache directories still used by existing MCP workers.
export async function disableLegacyInstall(codex, { timeoutMs = 20_000 } = {}) {
  const child = spawn(codex, ['app-server', '--stdio'], { stdio: ['pipe','pipe','ignore'] });
  const pending = new Map(); let id = 0;
  const rejectPending = error => { for (const p of pending.values()) p.reject(error); pending.clear(); };
  child.once('error', rejectPending);
  child.once('exit', () => rejectPending(new Error('Codex configuration service exited.')));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    const p = pending.get(response.id);
    if (!p) return;
    pending.delete(response.id);
    if (response.error) p.reject(new Error(response.error.message || 'Codex configuration failed.'));
    else p.resolve(response.result);
  });
  const timer = setTimeout(() => { rejectPending(new Error('Codex configuration timed out.')); child.kill('SIGTERM'); }, timeoutMs);
  const request = (method, params) => new Promise((resolve, reject) => {
    const next = ++id; pending.set(next, {resolve,reject});
    child.stdin.write(JSON.stringify({ id: next, method, params })+'\n', error => { if(error) { pending.delete(next);reject(error); } });
  });
  try {
    await request('initialize', { clientInfo: { name: 'chatgpt-bridge-installer', version: '1.0.0' } });
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const state = await request('config/read', {includeLayers:false});
    const legacy = 'chatgpt-chrome-bridge@personal';
    if (!state.config?.plugins?.[legacy]?.enabled) return false;
    await request('config/value/write', { keyPath: `plugins."${legacy}".enabled`, value:false, mergeStrategy:'replace' });
    const verified = await request('config/read', {includeLayers:false});
    if (verified.config?.plugins?.[legacy]?.enabled !== false) throw new Error('Legacy plugin was not disabled.');
    return true;
  } finally {
    clearTimeout(timer);lines.close();child.stdin.end();child.kill('SIGTERM');
  }
}
