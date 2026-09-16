import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bridgePaths, readJson, writeJsonAtomic } from './config.mjs';
import { readProcessSnapshot } from './profile-cache.mjs';

export const REPOSITORY = 'TheMakerOfWorlds/chatgpt-chrome-bridge';
export const PLUGIN = 'chatgpt-chrome-bridge';
export const MARKETPLACE = 'chatgpt-bridge-releases';
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const execFileAsync = promisify(execFile);
export const run = (command, args, options = {}) => execFileAsync(command, args, {
  env: { ...process.env, PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}` },
  ...options,
});
export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
export const validVersion = value => /^\d+\.\d+\.\d+$/.test(value);
export function newer(a, b) {
  if (!validVersion(a) || !validVersion(b)) throw new Error('Invalid release version.');
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i];
  return false;
}
export async function nodeExecutable() {
  // Homebrew changes Cellar paths on upgrades; use its stable symlink when it
  // resolves to this same runtime. Other Node installations retain execPath.
  const actual = await fs.realpath(process.execPath);
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    if (await fs.realpath(candidate).catch(() => null) === actual) return candidate;
  }
  return process.execPath;
}

export function installationPaths(stateRoot = bridgePaths().stateRoot) {
  const root = path.join(stateRoot, 'application');
  return { root, releases: path.join(root, 'releases'), state: path.join(root, 'installation.json'),
    lock: path.join(root, '.update-lock'), marketplace: path.join(root, 'marketplace'),
    source: path.join(root, 'marketplace', 'plugins', PLUGIN) };
}

export function validateBundle(buffer, manifest) {
  if (manifest.schema !== 1 || !validVersion(manifest.version) || manifest.repository !== REPOSITORY ||
      manifest.asset !== 'bridge.bundle.json.gz' || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '')) throw new Error('Invalid release manifest.');
  if (buffer.length > 20 * 1024 * 1024 || sha256(buffer) !== manifest.sha256) throw new Error('Release checksum mismatch.');
  const bundle = JSON.parse(gunzipSync(buffer, { maxOutputLength: 60 * 1024 * 1024 }));
  if (bundle.schema !== 1 || !Array.isArray(bundle.files) || bundle.files.length > 1000) throw new Error('Invalid release bundle.');
  const names = new Set();
  let bytes = 0;
  for (const file of bundle.files) {
    if (typeof file.path !== 'string' || !/^(scripts\/[a-zA-Z0-9_./-]+\.mjs|skills\/[a-zA-Z0-9_./-]+\.(md|yaml)|docs\/[a-zA-Z0-9_./-]+\.md|\.codex-plugin\/plugin\.json|\.mcp\.json|package(-lock)?\.json|README\.md|LICENSE|install\.sh|Setup\.command)$/.test(file.path) ||
        file.path.split('/').some(part => part === '..' || part === '.' || !part) || names.has(file.path)) throw new Error('Unsafe or duplicate release path.');
    if (typeof file.content !== 'string') throw new Error('Invalid release file.');
    names.add(file.path);
    bytes += Buffer.byteLength(file.content);
  }
  if (bytes > 30 * 1024 * 1024) throw new Error('Unpacked release is too large.');
  for (const file of ['package.json', 'package-lock.json', '.codex-plugin/plugin.json', '.mcp.json', 'scripts/mcp-server.mjs', 'scripts/manage.mjs']) if (!names.has(file)) throw new Error(`Missing release file: ${file}`);
  const get = name => JSON.parse(bundle.files.find(file => file.path === name).content);
  if (get('package.json').version !== manifest.version || get('.codex-plugin/plugin.json').name !== PLUGIN || get('.codex-plugin/plugin.json').version !== manifest.pluginVersion || manifest.pluginVersion.split('+')[0] !== manifest.version) throw new Error('Release versions do not match.');
  return bundle;
}

// Tokens are optional and only sent to api.github.com. GitHub CLI auth handles
// private releases without putting a token in arguments, logs, or saved state.
export async function githubRequest(apiPath, { binary = false, maxBytes = 20 * 1024 * 1024 } = {}) {
  if (!/^repos\/[A-Za-z0-9_./-]+$/.test(apiPath) || apiPath.includes('..')) throw new Error('Invalid GitHub API path.');
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const headers = { Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', 'User-Agent': PLUGIN };
      const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`https://api.github.com/${apiPath}`, { headers, signal: AbortSignal.timeout(20_000) });
      if ([401, 403, 404].includes(response.status) && !token) {
        try {
          const result = await run('gh', ['api', apiPath, '-H', `Accept: ${headers.Accept}`], { encoding: 'buffer', maxBuffer: maxBytes, timeout: 30_000 });
          return binary ? result.stdout : JSON.parse(result.stdout.toString());
        } catch { /* Return the actionable HTTP status without credential output. */ }
      }
      if (!response.ok) {
        const error = new Error(response.status === 404 ? 'GitHub release unavailable. For a private repository, run gh auth login with an authorized account. The maintainer must publish a release first.' : `GitHub update check failed (HTTP ${response.status}).`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      if (Number(response.headers.get('content-length') || 0) > maxBytes) throw new Error('GitHub response exceeds size limit.');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) throw new Error('GitHub response exceeds size limit.');
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      return binary ? data : JSON.parse(data.toString());
    } catch (error) {
      lastError = error;
      if (error.retryable === false || attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

export async function latestRelease(request = githubRequest) {
  const release = await request(`repos/${REPOSITORY}/releases/latest`, { maxBytes: 1024 * 1024 });
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error('No stable bridge release available.');
  const asset = name => {
    const match = release.assets?.find(item => item.name === name);
    if (!Number.isSafeInteger(match?.id)) throw new Error(`Release is missing ${name}.`);
    return `repos/${REPOSITORY}/releases/assets/${match.id}`;
  };
  const manifest = JSON.parse((await request(asset('release.json'), { binary: true, maxBytes: 64 * 1024 })).toString());
  if (`v${manifest.version}` !== release.tag_name) throw new Error('Release tag does not match manifest.');
  return { manifest, bundlePath: asset('bridge.bundle.json.gz'), url: `https://github.com/${REPOSITORY}/releases/tag/${release.tag_name}` };
}

export async function withUpdateLock(paths, callback) {
  await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
  try { await fs.mkdir(paths.lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readJson(path.join(paths.lock, 'owner.json'));
    let alive = true;
    if (owner?.pid) { try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; } }
    const info = await fs.stat(paths.lock);
    if ((!owner && Date.now() - info.mtimeMs > 60_000) || !alive) {
      await fs.rm(paths.lock, { recursive: true, force: true });
      return withUpdateLock(paths, callback);
    }
    throw new Error('Another bridge installation/update is running. Try again when it finishes.');
  }
  try {
    await writeJsonAtomic(path.join(paths.lock, 'owner.json'), { pid: process.pid });
    return await callback();
  } finally { await fs.rm(paths.lock, { recursive: true, force: true }); }
}

export async function prepareRelease(paths, manifest, buffer, { execute = run } = {}) {
  const bundle = validateBundle(buffer, manifest);
  if (Number(process.versions.node.split('.')[0]) < (manifest.minimumNodeMajor || 20)) throw new Error('Install Node.js 22 or newer, then retry.');
  const destination = path.join(paths.releases, `v${manifest.version}`);
  const existing = await readJson(path.join(destination, '.release.json'));
  if (existing) {
    if (existing.sha256 !== manifest.sha256) throw new Error('This release version was already installed with different contents. Publish a new version.');
    return destination;
  }
  const staging = path.join(paths.releases, `.staging-${process.pid}-${crypto.randomUUID()}`);
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const file of bundle.files) {
      const target = path.join(staging, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, { mode: 0o600 });
    }
    // An absolute Node path works when the GUI app has a minimal PATH.
    await writeJsonAtomic(path.join(staging, '.mcp.json'), { mcpServers: { [PLUGIN]: {
      command: await nodeExecutable(), args: ['./scripts/mcp-server.mjs'], cwd: '.',
    } } });
    const npm = path.join(path.dirname(process.execPath), 'npm');
    await execute(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(staging, '.npm-cache')], { cwd: staging, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
    await fs.rm(path.join(staging, '.npm-cache'), { recursive: true, force: true });
    await execute(process.execPath, ['scripts/mcp-server.mjs', '--healthcheck'], { cwd: staging, timeout: 20_000 });
    await writeJsonAtomic(path.join(staging, '.release.json'), manifest);
    await fs.rename(staging, destination);
    return destination;
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

export async function pruneReleases(paths, state, snapshot = readProcessSnapshot) {
  const processes = await snapshot();
  const keep = new Set([state.currentPath, state.previousPath].filter(Boolean));
  for (const entry of await fs.readdir(paths.releases, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^v\d+\.\d+\.\d+$/.test(entry.name)) continue;
    const target = path.join(paths.releases, entry.name);
    if (keep.has(target) || processes.some(item => item.command.includes(target))) continue;
    await fs.rm(target, { recursive: true, force: true });
  }
}

export async function writeMaintenanceCommand(paths) {
  const runner = path.join(paths.root, 'command.mjs');
  await fs.writeFile(runner, `import fs from 'node:fs/promises';
import { disableLegacyInstall } from './lib/codex-registration.mjs';\nimport {pathToFileURL} from 'node:url';\nconst state=JSON.parse(await fs.readFile(${JSON.stringify(paths.state)},'utf8'));\nconst {main}=await import(pathToFileURL(state.currentPath+'/scripts/manage.mjs'));\nawait main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});\n`);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const command = path.join(paths.root, 'bridge');
  await fs.writeFile(command, `#!/bin/sh\nexec ${quote(await nodeExecutable())} ${quote(runner)} "$@"\n`, { mode: 0o700 });
  return command;
}

export async function activateRelease(paths, destination, manifest, { execute = run, codex = 'codex', autoUpdate = true } = {}) {
  const previous = await readJson(paths.state, {});
  await fs.mkdir(path.dirname(paths.source), { recursive: true });
  const oldTarget = await fs.readlink(paths.source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const pointTo = async target => {
    const temp = `${paths.source}.${crypto.randomUUID()}.tmp`;
    await fs.symlink(target, temp);
    await fs.rename(temp, paths.source);
  };
  await pointTo(destination);
  const marketplaceFile = path.join(paths.marketplace, '.agents', 'plugins', 'marketplace.json');
  await writeJsonAtomic(marketplaceFile, { name: MARKETPLACE, interface: { displayName: 'ChatGPT Bridge Releases' }, plugins: [{
    name: PLUGIN, source: { source: 'local', path: `./plugins/${PLUGIN}` },
    policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity',
  }] });
  try {
    await execute(codex, ['plugin', 'marketplace', 'add', paths.marketplace], { timeout: 30_000 });
    await execute(codex, ['plugin', 'add', `${PLUGIN}@${MARKETPLACE}`], { timeout: 60_000 });
    const state = { ...previous, schema: 1, repository: REPOSITORY, currentVersion: manifest.version,
      pluginVersion: manifest.pluginVersion, currentPath: destination, previousPath: previous.currentPath === destination ? previous.previousPath : previous.currentPath,
      codex, autoUpdate, installedAt: new Date().toISOString(), lastError: null, availableVersion: null };
    await writeMaintenanceCommand(paths);
    await writeJsonAtomic(paths.state, state);
    await pruneReleases(paths, state).catch(() => {});
    return state;
  } catch (error) {
    if (oldTarget) {
      await pointTo(oldTarget);
      await execute(codex, ['plugin', 'add', `${PLUGIN}@${MARKETPLACE}`], { timeout: 60_000 }).catch(() => {});
    } else await fs.rm(paths.source, { force: true });
    throw new Error(`Codex registration failed; the previous bridge release was retained. ${error.message}`);
  }
}

export async function updateInstallation({ paths = installationPaths(), checkOnly = false, automatic = false,
  request = githubRequest, execute = run, codex, autoUpdate } = {}) {
  return withUpdateLock(paths, async () => {
    const state = await readJson(paths.state, {});
    if (automatic && (!state.currentVersion || !state.autoUpdate || Date.now() - Date.parse(state.lastCheckedAt || 0) < CHECK_INTERVAL_MS)) return state;
    const lastCheckedAt = new Date().toISOString();
    try {
      const latest = await latestRelease(request);
      const available = !state.currentVersion || newer(latest.manifest.version, state.currentVersion);
      await writeJsonAtomic(paths.state, { ...state, lastCheckedAt, lastError: null, availableVersion: available ? latest.manifest.version : null });
      if (!available || checkOnly) return { ...(await readJson(paths.state)), releaseUrl: latest.url };
      const buffer = await request(latest.bundlePath, { binary: true });
      const destination = await prepareRelease(paths, latest.manifest, buffer, { execute });
      return await activateRelease(paths, destination, latest.manifest, {
        execute, codex: codex || state.codex || 'codex', autoUpdate: autoUpdate ?? state.autoUpdate ?? true,
      });
    } catch (error) {
      await writeJsonAtomic(paths.state, { ...state, lastCheckedAt, lastError: error.message });
      throw error;
    }
  });
}

export async function rollbackInstallation(paths = installationPaths(), { execute = run } = {}) {
  return withUpdateLock(paths, async () => {
    const state = await readJson(paths.state, {});
    if (!state.previousPath || path.dirname(state.previousPath) !== paths.releases) throw new Error('No previous release available.');
    const manifest = await readJson(path.join(state.previousPath, '.release.json'));
    // Disable automatic updates so the rolled-back version stays selected.
    return activateRelease(paths, state.previousPath, manifest, { execute, codex: state.codex, autoUpdate: false });
  });
}
