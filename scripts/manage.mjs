#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { bridgePaths, listChromeProfiles, loadConfig, resolveChromeProfile, saveConfig, readJson, writeJsonAtomic } from './lib/config.mjs';
import { installationPaths, updateInstallation, rollbackInstallation, prepareRelease, activateRelease, withUpdateLock, run } from './lib/releases.mjs';

export function parseArgs(args) {
  const result = { command: args[0] || 'help' };
  const booleans = new Set(['skip-login', 'manual-updates', 'json']);
  const values = new Set(['profile', 'from-bundle', 'manifest', 'codex']);
  for (let i = 1; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw new Error(`Unexpected argument: ${args[i]}`);
    const name = args[i].slice(2);
    if (booleans.has(name)) result[name] = true;
    else if (values.has(name) && args[i + 1] && !args[i + 1].startsWith('--')) result[name] = args[++i];
    else throw new Error(`Unknown or incomplete option: --${name}`);
  }
  return result;
}

export async function setupLogin({ profile: requested, interactive = process.stdin.isTTY, paths = bridgePaths(), prompt, createBridge } = {}) {
  let reader;
  const ask = prompt || (async question => {
    if (!interactive) throw new Error('Choose a profile with --profile, or run setup in Terminal.');
    reader ||= createInterface({ input: process.stdin, output: process.stdout });
    return reader.question(question);
  });
  let bridge;
  try {
    const config = await loadConfig(paths);
    let profiles;
    try { profiles = await listChromeProfiles(paths); }
    catch { throw new Error('Open Google Chrome once to create a profile, then run setup again.'); }
    let selected;
    if (requested || config.profile) selected = await resolveChromeProfile(requested, paths, config.profile);
    else if (profiles.length === 1) selected = profiles[0];
    else {
      console.log('Choose the Chrome profile to use for ChatGPT:');
      profiles.forEach((profile, i) => console.log(`  ${i + 1}. ${profile.name} (${profile.directory})`));
      const answer = await ask('Profile number: ');
      if (!/^[1-9]\d*$/.test(answer.trim()) || !profiles[Number(answer) - 1]) throw new Error('Select one of the listed profile numbers.');
      selected = profiles[Number(answer) - 1];
    }
    await saveConfig({ ...config, profile: selected.directory }, paths);
    console.log(`Using ${selected.name} (${selected.directory}). Checking ChatGPT sign-in…`);
    const factory = createBridge || (async () => {
      const { ChatGptChromeBridge } = await import('./lib/bridge.mjs');
      return new ChatGptChromeBridge({ paths }).initialize();
    });
    bridge = await factory();
    try {
      const synced = await bridge.syncOptions({ profile: selected.directory, forceRescan: true });
      if (!synced.authenticated) throw new Error('ChatGPT sign-in required.');
      console.log(`Connected to ChatGPT. Available effort: ${synced.reasoningOptions.join(', ')}.`);
      return synced;
    } catch (error) {
      // Only authentication errors should open login; a UI/network failure needs
      // its real error, not an unnecessary account sign-in.
      if (!/sign(?:ed)?.?in|signed.?out|logged.?out|login|authenticated/i.test(error.message)) throw error;
      if (!interactive && !prompt) throw new Error('ChatGPT sign-in is needed. Run the login command in Terminal to finish in Chrome.');
      await bridge.openForLogin({ profile: selected.directory });
      console.log('Sign in to ChatGPT in the dedicated Chrome window. No API key is needed.');
      console.log('Then quit that dedicated Chrome instance completely with Command-Q.');
      for (let attempt = 0; attempt < 3; attempt++) {
        await ask('Press Return after signing in and quitting the dedicated Chrome window: ');
        try {
          const synced = await bridge.syncOptions({ profile: selected.directory, forceRescan: true });
          if (!synced.authenticated) throw new Error('ChatGPT still needs sign-in.');
          console.log('ChatGPT login verified. Setup is complete.');
          return synced;
        } catch (error) {
          if (attempt === 2) throw error;
          console.log(`Not connected yet: ${error.message}`);
        }
      }
    }
  } finally {
    reader?.close();
    if (bridge) { await bridge.closeBrowser(); clearInterval(bridge.retentionCleanupTimer); }
  }
}

async function writeCommand(paths) {
  const runner = path.join(paths.root, 'command.mjs');
  await fs.writeFile(runner, `import fs from 'node:fs/promises';\nimport {pathToFileURL} from 'node:url';\nconst state=JSON.parse(await fs.readFile(${JSON.stringify(paths.state)},'utf8'));\nconst {main}=await import(pathToFileURL(state.currentPath+'/scripts/manage.mjs'));\nawait main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});\n`);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const command = path.join(paths.root, 'bridge');
  await fs.writeFile(command, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runner)} "$@"\n`, { mode: 0o700 });
  return command;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args), paths = installationPaths();
  const output = value => console.log(JSON.stringify(value, null, 2));
  if (options.command === 'help' || options.command === '--help') {
    console.log('ChatGPT Bridge: install | login | doctor | check | update | rollback | auto-on | auto-off\nInstall options: --skip-login --profile "Profile 1" --manual-updates --codex /path/to/codex\nFor an offline release: --from-bundle bridge.bundle.json.gz --manifest release.json');
    return;
  }
  if (process.platform !== 'darwin' && !['check','doctor'].includes(options.command)) throw new Error('This release supports macOS with Google Chrome. Windows and Linux are not yet supported.');
  if (options.command === 'install') {
    await fs.access(bridgePaths().chromeExecutable).catch(() => { throw new Error('Install Google Chrome from https://www.google.com/chrome/ first.'); });
    const requestedCodex = options.codex || process.env.CHATGPT_BRIDGE_CODEX || 'codex';
    const codex = path.isAbsolute(requestedCodex) ? requestedCodex : (await run('/usr/bin/which', [requestedCodex]).catch(() => { throw new Error('Install the Codex CLI first: npm install -g @openai/codex'); })).stdout.trim();
    await run(codex, ['plugin', 'add', '--help']).catch(() => { throw new Error('Install/update the Codex CLI, then retry: npm install -g @openai/codex'); });
    console.log('Installing ChatGPT Bridge. Automatic stable-release updates are ' + (options['manual-updates'] ? 'off.' : 'on (checked every six hours while in use).'));
    let installed;
    if (options['from-bundle']) {
      if (!options.manifest) throw new Error('--manifest is required with --from-bundle.');
      const manifest = await readJson(path.resolve(options.manifest));
      const buffer = await fs.readFile(path.resolve(options['from-bundle']));
      installed = await withUpdateLock(paths, async () => {
        const destination = await prepareRelease(paths, manifest, buffer);
        return activateRelease(paths, destination, manifest, { codex, autoUpdate: !options['manual-updates'] });
      });
    } else installed = await updateInstallation({ paths, codex, autoUpdate: !options['manual-updates'] });
    const command = await writeCommand(paths);
    console.log(`Installed v${installed.currentVersion}. Maintenance command: ${command}`);
    if (!options['skip-login']) {
      const managed = await import(pathToFileURL(path.join(installed.currentPath, 'scripts/manage.mjs')));
      await managed.setupLogin({ profile: options.profile });
    }
    console.log('Start a new Codex task and ask: "Use ChatGPT to help me with this."');
    return installed;
  }
  if (options.command === 'login') return setupLogin({ profile: options.profile });
  if (options.command === 'doctor') {
    const state = await readJson(paths.state, {});
    let chrome = false; try { await fs.access(bridgePaths().chromeExecutable); chrome = true; } catch {}
    output({ platform: process.platform, node: process.version, chromeInstalled: chrome, installedVersion: state.currentVersion || null,
      automaticUpdates: state.autoUpdate ?? false, lastCheckedAt: state.lastCheckedAt || null, lastUpdateError: state.lastError || null,
      configuredProfile: (await loadConfig()).profile, loginCheck: 'Run the login command to verify ChatGPT access.' });
    return;
  }
  if (['auto-on','auto-off'].includes(options.command)) {
    return withUpdateLock(paths, async () => {
      const state = await readJson(paths.state);
      if (!state?.currentVersion) throw new Error('Install the managed bridge first.');
      await writeJsonAtomic(paths.state, { ...state, autoUpdate: options.command === 'auto-on' });
      console.log(`Automatic updates ${options.command === 'auto-on' ? 'enabled' : 'disabled'}.`);
    });
  }
  if (options.command === 'rollback') return output(await rollbackInstallation(paths));
  if (['check','update'].includes(options.command)) return output(await updateInstallation({ paths, checkOnly: options.command === 'check' }));
  throw new Error(`Unknown command: ${options.command}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch(error => { console.error(error.message); process.exitCode = 1; });
