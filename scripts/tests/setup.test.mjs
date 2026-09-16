import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setupLogin, setupProject, parseArgs } from '../manage.mjs';
import { bridgePaths, readJson } from '../lib/config.mjs';
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-setup-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const paths=bridgePaths({CHATGPT_CHROME_BRIDGE_STATE_DIR:path.join(root,'state'),CHATGPT_CHROME_USER_DATA_DIR:path.join(root,'Chrome')});
  for (const name of ['Profile 1','Profile 2']) await fs.mkdir(path.join(paths.chromeUserData,name),{recursive:true});
  await fs.writeFile(paths.localStateFile,JSON.stringify({profile:{last_used:'Profile 1',info_cache:{'Profile 1':{name:'One'},'Profile 2':{name:'Two'}}}}));
  return paths;
}
const result={authenticated:true,reasoningOptions:['Pro']};
test('setup chooses the user profile and leaves project unset for new users',async t=>{
  const paths=await fixture(t); let closed=0;
  await setupLogin({paths,prompt:async()=> '2',createBridge:async()=>({syncOptions:async options=>{assert.equal(options.profile,'Profile 2');return result;},closeBrowser:async()=>{closed++;}})});
  const config=await readJson(paths.configFile);assert.equal(config.profile,'Profile 2');assert.equal(config.projectUrl,null);assert.equal(closed,1);
});
test('setup preserves existing settings and completes browser login only when authentication is needed',async t=>{
  const paths=await fixture(t);
  await fs.mkdir(paths.stateRoot);await fs.writeFile(paths.configFile,JSON.stringify({profile:'Profile 2',projectUrl:'https://chatgpt.com/g/g-p-own/project',defaultReasoning:'High'}));
  let attempts=0,opened=0;
  await setupLogin({paths,prompt:async()=>'',createBridge:async()=>({syncOptions:async()=>{if(attempts++===0)throw new Error('Not signed in');return result;},openForLogin:async()=>{opened++;},closeBrowser:async()=>{}})});
  assert.equal(opened,1);assert.equal(attempts,2);
  assert.equal((await readJson(paths.configFile)).defaultReasoning,'High');
  assert.equal((await readJson(paths.configFile)).projectUrl,'https://chatgpt.com/g/g-p-own/project');
});
test('setup reports UI failures without requesting a new login',async t=>{
  const paths=await fixture(t);let opened=false;
  await assert.rejects(setupLogin({paths,profile:'Profile 1',createBridge:async()=>({syncOptions:async()=>{throw new Error('Effort control not found');},openForLogin:async()=>{opened=true;},closeBrowser:async()=>{}})}),/Effort control/);
  assert.equal(opened,false);
});
test('CLI rejects incomplete or misspelled flags',()=>{
  assert.equal(parseArgs(['install','--skip-login','--profile','Profile 2']).profile,'Profile 2');
  assert.throws(()=>parseArgs(['install','--profile']),/incomplete/);
  assert.throws(()=>parseArgs(['install','--force']),/Unknown/);
});

test('fresh project setup asks for a destination and Return chooses ordinary chats',async t=>{
  const paths=await fixture(t);let asked=0;
  const selected=await setupProject({paths,prompt:async question=>{asked++;assert.match(question,/Project URL/);return '';}});
  assert.equal(asked,1);assert.equal(selected.projectUrl,null);assert.equal(selected.needsChoice,false);
  assert.equal((await readJson(paths.configFile)).projectUrl,null);
});
test('project setup saves the user URL and preserves profile and effort',async t=>{
  const paths=await fixture(t);await fs.mkdir(paths.stateRoot);
  await fs.writeFile(paths.configFile,JSON.stringify({profile:'Profile 2',defaultReasoning:'High',projectUrl:null}));
  await setupProject({paths,prompt:async()=> 'https://chatgpt.com/g/g-p-own/project/?tracking=test'});
  const config=await readJson(paths.configFile);assert.equal(config.projectUrl,'https://chatgpt.com/g/g-p-own/project');
  assert.equal(config.profile,'Profile 2');assert.equal(config.defaultReasoning,'High');
  await setupProject({paths,prompt:async()=>''});assert.equal((await readJson(paths.configFile)).projectUrl,config.projectUrl);
  await setupProject({paths,prompt:async()=> 'none'});assert.equal((await readJson(paths.configFile)).projectUrl,null);
});
test('explicit project choices do not prompt and no-project clears an existing destination',async t=>{
  const paths=await fixture(t);const prompt=async()=>{throw new Error('must not ask twice');};
  await setupProject({paths,projectUrl:'https://chatgpt.com/g/g-p-own/project',prompt});
  assert.equal((await readJson(paths.configFile)).projectUrl,'https://chatgpt.com/g/g-p-own/project');
  await setupProject({paths,noProject:true,prompt});assert.equal((await readJson(paths.configFile)).projectUrl,null);
});
test('noninteractive setup without a choice preserves the preference and reports the missing choice',async t=>{
  const paths=await fixture(t);await setupProject({paths,projectUrl:'https://chatgpt.com/g/g-p-own/project'});
  const before=await fs.readFile(paths.configFile,'utf8');
  const result=await setupProject({paths,interactive:false});
  assert.equal(result.needsChoice,true);assert.equal(result.changed,false);assert.equal(await fs.readFile(paths.configFile,'utf8'),before);
});
test('invalid and conflicting project choices cannot overwrite saved settings',async t=>{
  const paths=await fixture(t);await setupProject({paths,noProject:true});const before=await fs.readFile(paths.configFile,'utf8');
  await assert.rejects(setupProject({paths,projectUrl:'https://example.com/project'}),/ChatGPT project URL/);
  await assert.rejects(setupProject({paths,projectUrl:'https://chatgpt.com/g/g-p-own/project',noProject:true}),/not both/);
  assert.equal(await fs.readFile(paths.configFile,'utf8'),before);
  assert.throws(()=>parseArgs(['install','--no-project','--project-url','https://chatgpt.com/g/g-p-own/project']),/not both/);
  assert.throws(()=>parseArgs(['install','--project-url','bad']),/Invalid ChatGPT project/);
  assert.equal(parseArgs(['project','--no-project'])['no-project'],true);
});
