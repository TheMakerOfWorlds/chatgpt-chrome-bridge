import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { disableLegacyInstall } from '../lib/codex-registration.mjs';
async function fixture(t, fail = false) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-registration-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const executable=path.join(root,'codex');
  const evidence=path.join(root,'evidence.json');
  await fs.writeFile(executable,`#!${process.execPath}
const fs=require('node:fs');let enabled=true;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(!r.id)return;
 let result={};
 if(r.method==='config/read')result={config:{plugins:{'chatgpt-chrome-bridge@personal':{enabled}}}};
 if(r.method==='config/value/write'){
  fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify(r.params));
  if(!${fail})enabled=r.params.value;
 }
 process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');
});\n`,{mode:0o700});
  return {executable,evidence};
}
test('migration disables only the legacy plugin through Codex without deleting active worker files',async t=>{
 const {executable,evidence}=await fixture(t);
 assert.equal(await disableLegacyInstall(executable),true);
 assert.deepEqual(JSON.parse(await fs.readFile(evidence)),{keyPath:'plugins."chatgpt-chrome-bridge@personal".enabled',value:false,mergeStrategy:'replace'});
});
test('migration verifies the actual resulting enabled setting',async t=>{
 const {executable}=await fixture(t,true);
 await assert.rejects(disableLegacyInstall(executable),/not disabled/);
});
