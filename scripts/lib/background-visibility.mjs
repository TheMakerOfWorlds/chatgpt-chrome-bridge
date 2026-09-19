import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

function checkedPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('A specific bridge Chrome PID is required.');
  return pid;
}

export function visibilityGuardScript(pid) {
  checkedPid(pid);
  // Chrome can unhide itself when a tab is created, without a workspace
  // activation notification. A small native loop catches that case too.
  return `ObjC.import('AppKit');
var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});
if (!app || app.terminated) throw new Error('Bridge Chrome has exited');
app.hide;
$.NSFileHandle.fileHandleWithStandardOutput.writeData($('ready\\n').dataUsingEncoding($.NSUTF8StringEncoding));
while (!app.terminated) {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.25));
  if (!app.terminated && !app.hidden) app.hide;
}`;
}

export async function startBackgroundVisibilityGuard(pid, { spawnProcess = spawn, onError = () => {} } = {}) {
  const child = spawnProcess('/usr/bin/osascript', ['-l', 'JavaScript', '-e', visibilityGuardScript(pid)], {stdio: ['ignore', 'pipe', 'pipe']});
  let stopping = false, ready = false, diagnostic = '';
  child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-1000); });
  const exited = new Promise(resolve => child.once('close', resolve));
  const stop = async () => {
    stopping = true;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Background visibility guard did not become ready.')), 5000);
      const fail = error => {clearTimeout(timer);reject(error);};
      child.once('error', fail);
      child.once('exit', () => { if (!ready) fail(new Error(`Background visibility guard exited: ${diagnostic.trim()}`)); });
      child.stdout.on('data', data => { if (String(data).includes('ready')) {ready = true;clearTimeout(timer);resolve();} });
    });
  } catch (error) { await stop(); throw error; }
  child.on('error', error => { if (!stopping) onError(error); });
  child.on('exit', code => { if (!stopping && code !== 0) onError(new Error(`Background visibility guard stopped: ${diagnostic.trim() || code}`)); });
  return { pid: child.pid, stop };
}

export async function unhideBridgeApplication(pid) {
  checkedPid(pid);
  await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).unhide;`], {timeout: 5000});
}
