import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { startBackgroundVisibilityGuard, visibilityGuardScript } from '../lib/background-visibility.mjs';

function fakeChild() {
 const child = new EventEmitter();
 Object.assign(child, {pid: 123, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough()});
 child.kill = () => {child.signalCode='SIGTERM';queueMicrotask(()=>{child.emit('exit',null);child.emit('close');});};
 return child;
}

test('visibility helper targets only a validated bridge PID',()=>{
 for(const invalid of [0,-1,NaN,1.5,'42; other-app']) assert.throws(()=>visibilityGuardScript(invalid),/PID/);
 assert.ok(visibilityGuardScript(123).includes('runningApplicationWithProcessIdentifier(123)'));
});
test('guard waits for readiness and stops cleanly without reporting an intentional stop',async()=>{
 const child=fakeChild();const errors=[];
 const guardPromise=startBackgroundVisibilityGuard(42,{spawnProcess:()=>{setImmediate(()=>child.stdout.write('ready\n'));return child;},onError:e=>errors.push(e)});
 const guard=await guardPromise;assert.equal(guard.pid,123);await guard.stop();assert.deepEqual(errors,[]);
});
test('guard surfaces startup failure and unexpected failure after startup',async()=>{
 const early=fakeChild();
 await assert.rejects(startBackgroundVisibilityGuard(42,{spawnProcess:()=>{setImmediate(()=>{early.stderr.write('denied');early.exitCode=1;early.emit('exit',1);early.emit('close');});return early;}}),/denied/);
 const child=fakeChild();const errors=[];
 await startBackgroundVisibilityGuard(42,{spawnProcess:()=>{setImmediate(()=>child.stdout.write('ready\n'));return child;},onError:e=>errors.push(e)});
 child.stderr.write('helper failed');child.exitCode=1;child.emit('exit',1);child.emit('close');assert.match(errors[0].message,/helper failed/);
});
test('a spawn error rejects without hanging cleanup',async()=>{
 const child=fakeChild();
 await assert.rejects(startBackgroundVisibilityGuard(42,{spawnProcess:()=>{setImmediate(()=>{child.emit('error',new Error('missing executable'));child.emit('close');});return child;}}),/missing executable/);
});
