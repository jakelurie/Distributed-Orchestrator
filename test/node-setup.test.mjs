import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-setup-'));
try {
  const check = net.createServer();
  await new Promise((r) => check.listen(0, '127.0.0.1', r));
  const port = check.address().port;
  await new Promise((r) => check.close(r));
  async function setup() {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/setup-node.mjs', import.meta.url))], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', step = 0;
    child.stdout.on('data', (data) => {
      output += data;
      if (step === 0 && output.includes('Machine name [')) { step++; child.stdin.write('My PC\n'); }
      if (step === 1 && output.includes('HTTP port [')) { step++; child.stdin.write(`${port}\n`); }
      if (step === 2 && output.includes('Data directory [')) { step++; child.stdin.write(path.join(dir, 'data') + '\n'); }
    });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => child.kill(), 5000);
    const code = await new Promise((r) => child.on('exit', r));
    clearTimeout(timer);
    return { code, output };
  }
  assert.equal((await setup()).code, 0);
  const text = await fs.readFile(path.join(dir, '.orchestrator-node.env'), 'utf8');
  assert.doesNotMatch(text, /HARNESS_TOKEN/);
  assert.match(text, /ORCHESTRATOR_NODE_NAME="My PC"/);
  assert.equal((await fs.stat(path.join(dir, '.orchestrator-node.env'))).mode & 0o777, 0o600);
  assert.equal((await setup()).code, 1);
  assert.equal(await fs.readFile(path.join(dir, '.orchestrator-node.env'), 'utf8'), text);
  console.log('PASS interactive node setup, private credentials, and overwrite protection');
} finally { await fs.rm(dir, { force: true, recursive: true }); }
