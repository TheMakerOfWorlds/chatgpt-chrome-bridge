import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { installationPaths, sha256, REPOSITORY, validateBundle, newer, prepareRelease, activateRelease, updateInstallation, rollbackInstallation, withUpdateLock } from '../lib/releases.mjs';
import { readJson, writeJsonAtomic } from '../lib/config.mjs';
function release(version = '0.2.0') {
  const files = [
    ['package.json', JSON.stringify({version})], ['package-lock.json','{}'],
    ['.codex-plugin/plugin.json',JSON.stringify({name:'chatgpt-chrome-bridge',version})],
    ['.mcp.json','{}'], ['scripts/mcp-server.mjs','console.log("ok")'], ['scripts/manage.mjs','export const main=()=>{}'],
  ].map(([path,content])=>({path,content}));
  const buffer = gzipSync(JSON.stringify({schema:1,files}));
  return { files, buffer, manifest:{schema:1,repository:REPOSITORY,version,pluginVersion:version,asset:'bridge.bundle.json.gz',sha256:sha256(buffer)} };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'bridge-updates-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return {root,paths:installationPaths(root)};
}
function requestFor(r, calls=[]) {
  return async api => {
    calls.push(api);
    if (api.endsWith('/latest')) return {tag_name:`v${r.manifest.version}`,assets:[{name:'release.json',id:1},{name:'bridge.bundle.json.gz',id:2}]};
    if (api.endsWith('/1')) return Buffer.from(JSON.stringify(r.manifest));
    if (api.endsWith('/2')) return r.buffer;
    throw new Error('Unexpected request');
  };
}

test('stable release comparison is numeric and bundle rejects corruption, traversal, duplicate files, and mismatched versions', () => {
  assert.ok(newer('0.10.0','0.9.0')); assert.equal(newer('0.2.0','0.2.0'),false);
  assert.throws(()=>newer('main','0.2.0'));
  const r=release(); assert.equal(validateBundle(r.buffer,r.manifest).files.length,6);
  assert.throws(()=>validateBundle(Buffer.from('bad'),r.manifest),/checksum/);
  for (const extra of [{path:'scripts/../../outside.mjs',content:'bad'},{path:'package.json',content:'{}'},{path:'/tmp/evil',content:'bad'},{path:'.env',content:'secret'}]) {
    const buffer=gzipSync(JSON.stringify({schema:1,files:[...r.files,extra]}));
    assert.throws(()=>validateBundle(buffer,{...r.manifest,sha256:sha256(buffer)}),/path/);
  }
  assert.throws(()=>validateBundle(r.buffer,{...r.manifest,version:'0.3.0'}),/versions/);
});

test('failed dependency preparation removes staging and never replaces the working release', async t => {
  const {paths}=await fixture(t), r=release();
  await writeJsonAtomic(paths.state,{currentVersion:'0.1.0'});
  await assert.rejects(prepareRelease(paths,r.manifest,r.buffer,{execute:async()=>{throw new Error('npm unavailable');}}),/npm unavailable/);
  assert.deepEqual(await fs.readdir(paths.releases),[]);
  assert.equal((await readJson(paths.state)).currentVersion,'0.1.0');
});

test('install validates in staging then switches Codex, keeps login data, and rolls back without automatic re-upgrade', async t => {
  const {paths,root}=await fixture(t), calls=[];
  const execute=async (command,args,options)=>{calls.push({command,args,options});return {stdout:''};};
  const login=path.join(root,'config.json'); await writeJsonAtomic(login,{profile:'Profile 9',projectUrl:'https://chatgpt.com/g/g-p-mine/project'});
  const first=release();
  await updateInstallation({paths,request:requestFor(first),execute,codex:'/test/codex'});
  assert.equal((await readJson(paths.state)).currentVersion,'0.2.0');
  assert.ok(calls.find(call=>call.args.includes('--healthcheck')));
  assert.ok(calls.find(call=>call.args.includes('--ignore-scripts') && call.args.includes('--cache')));
  assert.equal(await fs.readlink(paths.source),path.join(paths.releases,'v0.2.0'));
  const before=await fs.readFile(login);
  await updateInstallation({paths,request:requestFor(release('0.3.0')),execute});
  assert.equal((await readJson(paths.state)).previousPath,path.join(paths.releases,'v0.2.0'));
  const rollback=await rollbackInstallation(paths,{execute});
  assert.equal(rollback.currentVersion,'0.2.0'); assert.equal(rollback.autoUpdate,false);
  assert.deepEqual(await fs.readFile(login),before);
  let requested=false;
  await updateInstallation({paths,automatic:true,request:async()=>{requested=true;}});
  assert.equal(requested,false);
});

test('failed Codex activation restores previous marketplace source and installation metadata', async t => {
  const {paths}=await fixture(t), first=release();
  const execute=async()=>({stdout:''});
  await updateInstallation({paths,request:requestFor(first),execute});
  const before=await readJson(paths.state), oldTarget=await fs.readlink(paths.source), next=release('0.3.0');
  const destination=await prepareRelease(paths,next.manifest,next.buffer,{execute});
  await assert.rejects(activateRelease(paths,destination,next.manifest,{execute:async(_,args)=>{
    if(args[1]==='add') throw new Error('Codex unavailable');return {stdout:''};
  }}),/previous bridge release was retained/);
  assert.deepEqual(await readJson(paths.state),before);
  assert.equal(await fs.readlink(paths.source),oldTarget);
});

test('update checks throttle, do not download on check-only, do not downgrade, and preserve current release offline', async t => {
  const {paths}=await fixture(t), execute=async()=>({stdout:''});
  await updateInstallation({paths,request:requestFor(release()),execute});
  const calls=[];
  const checked=await updateInstallation({paths,checkOnly:true,request:requestFor(release('0.3.0'),calls),execute});
  assert.equal(checked.availableVersion,'0.3.0');assert.equal(checked.currentVersion,'0.2.0');
  assert.equal(calls.some(call=>call.endsWith('/2')),false);
  const before=calls.length;
  await updateInstallation({paths,automatic:true,request:requestFor(release('0.3.0'),calls),execute});
  assert.equal(calls.length,before);
  await updateInstallation({paths,request:requestFor(release('0.1.0')),execute});
  assert.equal((await readJson(paths.state)).currentVersion,'0.2.0');
  await assert.rejects(updateInstallation({paths,request:async()=>{throw new Error('offline');},execute}),/offline/);
  assert.equal((await readJson(paths.state)).currentVersion,'0.2.0');
  assert.equal((await readJson(paths.state)).lastError,'offline');
});

test('a live updater lock prevents concurrent installs; a dead owner is recovered', async t => {
  const {paths}=await fixture(t);
  await withUpdateLock(paths,async()=>{
    await assert.rejects(withUpdateLock(paths,async()=>{}),/Another bridge/);
  });
  await fs.mkdir(paths.lock);
  await writeJsonAtomic(path.join(paths.lock,'owner.json'),{pid:2147483647});
  let ran=false;
  await withUpdateLock(paths,async()=>{ran=true;});
  assert.equal(ran,true);
});
