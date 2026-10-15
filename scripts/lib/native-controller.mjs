import { LIGHTWEIGHT_CHROME_ARGUMENTS } from "./profile-cache.mjs";
import { execFile, execFileSync, spawn } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MACOS_OPEN_EXECUTABLE = "/usr/bin/open";
const PROCESS_LIST_ARGUMENTS = ["-axww", "-o", "pid=,command="];
const nativeOperations = {
  spawn,
  reservePort: reserveLoopbackPort,
  processList: async () => (await execFileAsync("/bin/ps", PROCESS_LIST_ARGUMENTS, { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 })).stdout,
  processListSync: () => execFileSync("/bin/ps", PROCESS_LIST_ARGUMENTS, { encoding: "utf8", timeout: 2_000, maxBuffer: 4 * 1024 * 1024 }),
  signal: (pid, signal) => process.kill(pid, signal),
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export function chromeApplicationPath(executable) {
  const normalized = String(executable || "");
  const marker = ".app/Contents/MacOS/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) return null;
  return normalized.slice(0, markerIndex + ".app".length);
}

export function buildMacOpenArguments({
  applicationPath,
  background,
  chromeArguments,
}) {
  if (!applicationPath) throw new Error("A macOS Chrome application path is required.");
  return [
    "-W",
    "-n",
    ...(background ? ["-g", "-j"] : []),
    "-a",
    applicationPath,
    "--args",
    ...chromeArguments,
  ];
}

export async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("Could not reserve a loopback port."));
        else resolve(port);
      });
    });
  });
}

export function buildNativeControllerArguments({
  userDataDir,
  profileDirectory,
  port,
  background,
  url,
}) {
  return [
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileDirectory}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    "--new-window",
    "--no-first-run",
    "--no-default-browser-check",
    ...LIGHTWEIGHT_CHROME_ARGUMENTS,
    ...(background
      ? ["--window-position=-32000,-32000", "--window-size=1440,1000"]
      : []),
    url,
  ];
}

async function waitForDevTools(endpoint, child, timeoutMs, operations, launchError) {
  const started = operations.now();
  let lastError = null;
  while (operations.now() - started < timeoutMs) {
    if (launchError()) throw launchError();
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(
        `Native Chrome exited before its control endpoint was ready (exit ${child.exitCode}). ` +
          "The private profile may still be open in another Chrome process.",
      );
    }
    try {
      const response = await operations.fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return await response.json();
      lastError = new Error(`DevTools returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await operations.sleep(100);
  }
  if (launchError()) throw launchError();
  throw new Error(
    `Timed out waiting for native Chrome's loopback control endpoint: ${
      lastError?.message || "unknown error"
    }`,
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function chromeProcessIds(psOutput, { port, userDataDir, executable }) {
  if (!Number.isSafeInteger(Number(port)) || Number(port) <= 0 || !userDataDir) return [];
  const portArgument = new RegExp(`(?:^|\\s)--remote-debugging-port=${Number(port)}(?=\\s|$)`);
  // ps joins argv with spaces, including spaces inside the profile path. The
  // bridge always follows this argument with another --flag; require that
  // boundary so worker-1 can never match worker-10 or "worker-1 backup".
  const dataArgument = new RegExp(`(?:^|\\s)--user-data-dir=${escapeRegExp(userDataDir)}(?=\\s+--[a-zA-Z]|$)`);
  const result = [];
  for (const line of String(psOutput || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const command = match[2];
    const commandExecutable = command.split(/\s+--/)[0];
    const isChrome = executable
      ? commandExecutable === executable
      : /(?:^|\/)(?:Google Chrome(?: Canary| Beta| Dev)?|Chromium|chrome|chromium|chromium-browser)$/.test(commandExecutable);
    if (!isChrome || /(?:^|\s)--type=/.test(command)) continue;
    if (!portArgument.test(command) || !dataArgument.test(command)) continue;
    const pid = Number(match[1]);
    if (Number.isSafeInteger(pid) && pid > 0) result.push(pid);
  }
  return result;
}

export function parseChromeProcessId(psOutput, identity) {
  return chromeProcessIds(psOutput, identity)[0] || null;
}

async function resolveChromeProcessId(identity, operations) {
  const pids = chromeProcessIds(await operations.processList(), identity);
  if (pids.length === 1) return pids[0];
  throw new Error(
    `Chrome opened its DevTools endpoint on port ${identity.port}, but its unique process ID could not be resolved.`,
  );
}

function processIsRunning(pid, operations) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { operations.signal(pid, 0); return true; }
  catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function createChromeProcessController(launcher, processId, identity, operations) {
  const controller = {
    pid: processId,
    launcherPid: launcher.pid,
    get exitCode() {
      return processIsRunning(processId, operations) ? null : launcher.exitCode ?? 0;
    },
    get signalCode() {
      return processIsRunning(processId, operations) ? null : launcher.signalCode;
    },
    kill(signal = "SIGTERM") {
      // The LaunchServices launcher may already have exited. Revalidate the
      // actual Chrome identity before signalling, including against PID reuse.
      if (!chromeProcessIds(operations.processListSync(), identity).includes(processId)) return false;
      try { operations.signal(processId, signal); return true; }
      catch (error) {
        if (error?.code === "ESRCH") return false;
        throw error;
      }
    },
    once(event, listener) {
      launcher.once(event, listener);
      return controller;
    },
    removeListener(event, listener) {
      launcher.removeListener(event, listener);
      return controller;
    },
  };
  return controller;
}

export async function stopNativeControlledChrome(launched, overrides = {}) {
  const operations = { ...nativeOperations, ...overrides };
  const { launcher, executable, userDataDir, port } = launched;
  const identity = { executable, userDataDir, port };
  if (!launcher || !executable || !userDataDir || !Number.isSafeInteger(port)) {
    throw new Error("Native Chrome cleanup requires its exact launch identity.");
  }
  try {
    // open -W is only the waiter, not Chrome. A still-pending LaunchServices
    // request cannot be proven cancelled merely by stopping this process.
    const launcherWasRunning = launcher.exitCode == null && launcher.signalCode == null && Boolean(launcher.pid);
    let observedChrome = Number.isSafeInteger(launched.processId) && launched.processId > 0;
    if (observedChrome) launched.pendingLaunchUnverified = false;
    else if (launched.applicationPath && launcherWasRunning) launched.pendingLaunchUnverified = true;
    // Retain uncertainty across cleanup retries: killing open once does not
    // make its unobserved LaunchServices request safe on the next invocation.
    if (launcherWasRunning) {
      launcher.kill("SIGTERM");
      const deadline = operations.now() + 1_000;
      while (processIsRunning(launcher.pid, operations) && operations.now() < deadline) {
        await operations.sleep(50);
      }
      if (processIsRunning(launcher.pid, operations)) launcher.kill("SIGKILL");
    }
    const started = operations.now();
    let quietSince = null;
    const signalled = new Set();
    while (operations.now() - started < 4_000) {
      const pids = chromeProcessIds(await operations.processList(), identity);
      observedChrome ||= pids.length > 0;
      if (pids.length > 0) launched.pendingLaunchUnverified = false;
      const launcherRunning = launcher.pid && processIsRunning(launcher.pid, operations);
      if (pids.length === 0 && !launcherRunning) {
        quietSince ??= operations.now();
        if (!launched.pendingLaunchUnverified && operations.now() - quietSince >= 500) return { stopped: true };
      } else {
        quietSince = null;
        for (const pid of pids) {
          const signal = operations.now() - started >= 1_500 ? "SIGKILL" : "SIGTERM";
          const key = `${pid}:${signal}`;
          if (signalled.has(key)) continue;
          try { operations.signal(pid, signal); }
          catch (error) { if (error?.code !== "ESRCH") throw error; }
          signalled.add(key);
        }
      }
      await operations.sleep(100);
    }
    throw new Error(observedChrome
      ? "The dedicated Chrome process did not stop within the cleanup timeout."
      : "A pending Chrome launch could not be verified cancelled.");
  } catch (cause) {
    const error = new Error(`Native Chrome cleanup could not be confirmed; its private profile was retained. ${cause.message}`, { cause });
    error.nativeChromeCleanupConfirmed = false;
    error.nativeChromeLaunch = launched;
    throw error;
  }
}

export async function launchNativeControlledChrome({
  executable,
  userDataDir,
  profileDirectory,
  background,
  url,
  timeoutMs = 15_000,
}, overrides = {}) {
  const operations = { ...nativeOperations, ...overrides };
  let port;
  try { port = await operations.reservePort(); }
  catch (error) { error.nativeChromeCleanupConfirmed = true; throw error; }
  const args = buildNativeControllerArguments({
    userDataDir,
    profileDirectory,
    port,
    background,
    url,
  });
  const applicationPath = chromeApplicationPath(executable);
  const launchExecutable = applicationPath
    ? MACOS_OPEN_EXECUTABLE
    : executable;
  const launchArgs = applicationPath
    ? buildMacOpenArguments({
        applicationPath,
        background,
        chromeArguments: args,
      })
    : args;
  let launcher;
  try { launcher = operations.spawn(launchExecutable, launchArgs, { stdio: "ignore" }); }
  catch (error) { error.nativeChromeCleanupConfirmed = true; throw error; }
  let spawnError = null;
  launcher.once("error", (error) => { spawnError = error; });
  const endpoint = `http://127.0.0.1:${port}`;
  const launched = {
    launcher, endpoint, port, args, executable, userDataDir,
    applicationPath, launchExecutable, launchArgs,
    backgroundLaunch: Boolean(applicationPath && background),
  };
  try {
    launched.version = await waitForDevTools(endpoint, launcher, timeoutMs, operations, () => spawnError);
    launched.processId = applicationPath
      ? await resolveChromeProcessId({ port, userDataDir, executable }, operations)
      : launcher.pid;
    launched.child = applicationPath
      ? createChromeProcessController(launcher, launched.processId, { port, userDataDir, executable }, operations)
      : launcher;
    return launched;
  } catch (error) {
    try {
      await stopNativeControlledChrome(launched, operations);
      error.nativeChromeCleanupConfirmed = true;
    } catch (cleanupError) {
      error.nativeChromeCleanupConfirmed = false;
      error.nativeChromeCleanupError = cleanupError.message;
      error.nativeChromeLaunch = launched;
      error.message += ` ${cleanupError.message}`;
    }
    throw error;
  }
}
