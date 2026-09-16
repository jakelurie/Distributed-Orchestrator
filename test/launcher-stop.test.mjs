import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stopServer, matchesServer } from '../scripts/stop-server.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-stop-'));
let child;
async function launch(file) {
  const p = spawn(process.execPath, [file], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const done = once(p, 'exit');
  const [data] = await once(p.stdout, 'data');
  return { p, done, port: Number(data.toString().trim()) };
}
try {
  await fs.mkdir(path.join(root, 'server'));
  const code = "require('http').createServer((q,r)=>r.end('ok')).listen(0,'127.0.0.1',function(){console.log(this.address().port)});";
  await fs.writeFile(path.join(root, 'server/index.js'), code);
  child = await launch('server/index.js');
  assert.equal(matchesServer(process.execPath + ' server/index.js', root, root), true);
  await stopServer(root, child.port);
  await child.done;
  assert.notEqual(child.p.exitCode === null && child.p.signalCode === null, true);
  await stopServer(root, child.port); // already stopped
  await fs.writeFile(path.join(root, 'other.js'), code);
  child = await launch('other.js');
  await assert.rejects(stopServer(root, child.port), /another program/);
  assert.equal(child.p.exitCode, null);
  assert.equal((await fetch('http://127.0.0.1:' + child.port)).status, 200);
  console.log('PASS adopted server stops, repeated stop is safe, unrelated listener stays running');
} finally {
  if (child && child.p.exitCode === null && child.p.signalCode === null) {
    child.p.kill(); await child.done;
  }
  await fs.rm(root, { recursive: true, force: true });
}
