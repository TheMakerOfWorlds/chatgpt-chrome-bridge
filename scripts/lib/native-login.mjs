import { spawn } from "node:child_process";

const DEFAULT_STARTUP_GRACE_MS = 750;

export function buildNativeLoginArguments({
  userDataDir,
  profileDirectory,
  url,
}) {
  return [
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileDirectory}`,
    "--new-window",
    "--no-first-run",
    "--no-default-browser-check",
    url,
  ];
}

function earlyExitError(code, signal) {
  const detail = signal
    ? `signal ${signal}`
    : `exit code ${code === null ? "unknown" : code}`;
  return new Error(
    `Native login Chrome exited before its window was ready (${detail}). ` +
      "Another bridge login Chrome process may still be using this private " +
      "profile. Quit that dedicated Chrome instance completely and retry.",
  );
}

export async function waitForNativeLoginStartup(
  child,
  { graceMs = DEFAULT_STARTUP_GRACE_MS } = {},
) {
  if (!child || typeof child.once !== "function") {
    throw new TypeError("A spawned Chrome child process is required.");
  }
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new RangeError("Native login startup grace must be a non-negative number.");
  }
  if (child.exitCode !== null && child.exitCode !== undefined) {
    throw earlyExitError(child.exitCode, child.signalCode || null);
  }

  await new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(earlyExitError(code, signal));
    };
    const onError = (error) => {
      cleanup();
      reject(
        new Error(`Native login Chrome could not start: ${error.message}`, {
          cause: error,
        }),
      );
    };
    child.once("exit", onExit);
    child.once("error", onError);
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, graceMs);
  });
  return child;
}

export async function launchNativeLogin({
  executable,
  userDataDir,
  profileDirectory,
  url,
  startupGraceMs = DEFAULT_STARTUP_GRACE_MS,
}) {
  const args = buildNativeLoginArguments({
    userDataDir,
    profileDirectory,
    url,
  });
  const child = spawn(executable, args, {
    detached: true,
    stdio: "ignore",
  });
  await waitForNativeLoginStartup(child, { graceMs: startupGraceMs });
  child.unref();
  return { pid: child.pid, args };
}
