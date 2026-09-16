import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/core/store.js';
import { HARNESS_ROOT, HARNESS_APP_ID } from '../src/core/harness-guard.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'checkout-path-'));
try {
  await store.init(dir);
  const session = store.newSession({name:'old', model:'test', projectDir:'/old/testAstra', appId:HARNESS_APP_ID});
  await store.save(session);
  assert.equal((await store.load(session.id, {repair:false})).projectDir, HARNESS_ROOT);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'sessions',session.id+'.json'))).projectDir, HARNESS_ROOT);
  const other = store.newSession({name:'other', model:'test', projectDir:'/other/project'});
  await store.save(other);
  assert.equal((await store.load(other.id)).projectDir, '/other/project');
  console.log('PASS built-in sessions follow checkout; other projects unchanged');
} finally { await fs.rm(dir,{recursive:true,force:true}); }
