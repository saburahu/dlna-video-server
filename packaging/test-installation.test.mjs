import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';import path from'node:path';import os from'node:os';import{prepareTestInstallation,assertTestControlData}from'./test-installation.mjs';
test('negative setup cases reach product validation but start/stop never touch external data',()=>{
 const home=path.resolve('synthetic-run'),app=path.resolve('synthetic-app');
 assert.doesNotThrow(()=>assertTestControlData(home,app,'setup',path.join(app,'unsafe')));
 for(const command of['start','stop','backup'])assert.throws(()=>assertTestControlData(home,app,command,path.join(app,'unsafe')));
 assert.throws(()=>assertTestControlData(home,app,'setup',path.resolve('outside')));
});
test('repeat tests keep executable paths fixed while resetting apps and isolating data',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'stable-install-fixture-')),old=process.env.DLNA_TEST_INSTALL_ROOT;process.env.DLNA_TEST_INSTALL_ROOT=path.join(root,'fixed');
 try{const source=path.join(root,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'synthetic.txt'),'fixture');
  const a=await prepareTestInstallation(source,'private');await assert.rejects(prepareTestInstallation(source,'private'),/Another test session/);
  await fs.writeFile(path.join(a.app,'leftover.txt'),'old');await a.release();const b=await prepareTestInstallation(source,'private');
  assert.equal(a.app,b.app);assert.equal(a.alternate,b.alternate);assert.notEqual(a.home,b.home);await assert.rejects(fs.stat(path.join(b.app,'leftover.txt')));await b.release();
  const c=await prepareTestInstallation(source,'public');assert.notEqual(c.app,b.app);await fs.writeFile(path.join(c.app,'launcher.json'),JSON.stringify({data:root}));await c.release();
  await assert.rejects(prepareTestInstallation(source,'public'),/external\/live data/);
 }finally{if(old===undefined)delete process.env.DLNA_TEST_INSTALL_ROOT;else process.env.DLNA_TEST_INSTALL_ROOT=old;assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true});}
});
