import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MACOS_OPEN_EXECUTABLE = "/usr/bin/open";
const MACOS_LSOF_EXECUTABLE = "/usr/sbin/lsof";

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
    ...(background ? ["-g"] : []),
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
    ...(background
      ? ["--window-position=-32000,-32000", "--window-size=1440,1000"]
      : []),
    url,
  ];
}

async function waitForDevTools(endpoint, child, timeoutMs) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `Native Chrome exited before its control endpoint was ready (exit ${child.exitCode}). ` +
          "The private profile may still be open in another Chrome process.",
      );
    }
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return await response.json();
      lastError = new Error(`DevTools returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for native Chrome's loopback control endpoint: ${
      lastError?.message || "unknown error"
    }`,
  );
}

export function parseChromeProcessId(psOutput, { port, userDataDir }) {
  const portNeedle = `--remote-debugging-port=${port}`;
  const dataNeedle = `--user-data-dir=${userDataDir}`;
  for (const line of String(psOutput || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const command = match[2];
    if (!command.includes(portNeedle) || !command.includes(dataNeedle)) continue;
    const pid = Number(match[1]);
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
  }
  return null;
}

async function resolveChromeProcessId({ port, userDataDir }) {
  try {
    const { stdout } = await execFileAsync(MACOS_LSOF_EXECUTABLE, [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-t",
    ]);
    const pid = Number(String(stdout || "").trim().split(/\s+/)[0]);
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
  } catch {
    // Fall through to a command-line match. A newly started listener can race
    // lsof briefly even after its DevTools HTTP endpoint answers.
  }

  const { stdout } = await execFileAsync("/bin/ps", [
    "-axww",
    "-o",
    "pid=,command=",
  ]);
  const pid = parseChromeProcessId(stdout, { port, userDataDir });
  if (pid) return pid;
  throw new Error(
    `Chrome opened its DevTools endpoint on port ${port}, but its process ID could not be resolved.`,
  );
}

function createChromeProcessController(launcher, processId) {
  const controller = {
    pid: processId,
    launcherPid: launcher.pid,
    get exitCode() {
      return launcher.exitCode;
    },
    get signalCode() {
      return launcher.signalCode;
    },
    kill(signal = "SIGTERM") {
      try {
        process.kill(processId, signal);
        return true;
      } catch (error) {
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

export async function launchNativeControlledChrome({
  executable,
  userDataDir,
  profileDirectory,
  background,
  url,
  timeoutMs = 15_000,
}) {
  const port = await reserveLoopbackPort();
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
  const launcher = spawn(launchExecutable, launchArgs, { stdio: "ignore" });
  const endpoint = `http://127.0.0.1:${port}`;
  let child = launcher;
  try {
    const version = await waitForDevTools(endpoint, launcher, timeoutMs);
    const processId = applicationPath
      ? await resolveChromeProcessId({ port, userDataDir })
      : launcher.pid;
    if (applicationPath) {
      child = createChromeProcessController(launcher, processId);
    }
    return {
      child,
      launcher,
      endpoint,
      port,
      args,
      version,
      processId,
      applicationPath,
      launchExecutable,
      launchArgs,
      backgroundLaunch: Boolean(applicationPath && background),
    };
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGTERM");
    throw error;
  }
}
