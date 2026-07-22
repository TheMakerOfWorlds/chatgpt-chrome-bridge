import { spawn } from "node:child_process";
import net from "node:net";

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
  const child = spawn(executable, args, { stdio: "ignore" });
  const endpoint = `http://127.0.0.1:${port}`;
  try {
    const version = await waitForDevTools(endpoint, child, timeoutMs);
    return { child, endpoint, port, args, version };
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGTERM");
    throw error;
  }
}
