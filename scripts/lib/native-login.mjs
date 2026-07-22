import { spawn } from "node:child_process";

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

export function launchNativeLogin({
  executable,
  userDataDir,
  profileDirectory,
  url,
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
  child.unref();
  return { pid: child.pid, args };
}
