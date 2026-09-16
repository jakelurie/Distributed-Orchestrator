import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator bootstrap '));
let blocker;
try {
  for (const folder of ['scripts', 'src/core', 'server', '.launcher', 'node_modules/cross-spawn']) await fs.mkdir(path.join(dir, folder), { recursive: true });
  await fs.copyFile('scripts/start.mjs', path.join(dir, 'scripts/start.mjs'));
  await fs.copyFile('src/core/platform.js', path.join(dir, 'src/core/platform.js'));
  await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
  await fs.writeFile(path.join(dir, 'node_modules/cross-spawn/package.json'), '{}');
  await fs.writeFile(path.join(dir, '.launcher/dependencies.sha256'), crypto.createHash('sha256').update('{}').digest('hex'));
  await fs.writeFile(path.join(dir, 'server/index.js'), `import http from 'node:http';
    const server = http.createServer((req, res) => { res.end('ok'); setTimeout(() => server.close(), 100); });
    server.listen(Number(process.env.HARNESS_PORT), '127.0.0.1'); setTimeout(() => process.exit(0), 2000);`);
  blocker = net.createServer((socket) => socket.destroy());
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  await new Promise(r => blocker.close(r));
  const env = { ...process.env, HARNESS_PORT: String(port), HARNESS_DATA_DIR: path.join(dir, 'data'), HARNESS_TOKEN: 'test-only-token' };
  const run = () => promisify(execFile)(process.execPath, [path.join(dir, 'scripts/start.mjs'), '--no-browser'], { env, timeout: 10000 });
  assert.match((await run()).stdout, /Join an existing system/);
  const config = await fs.readFile(path.join(dir, '.orchestrator-node.env'), 'utf8');
  await run();
  assert.equal(await fs.readFile(path.join(dir, '.orchestrator-node.env'), 'utf8'), config);
  await new Promise(r => blocker.listen(port, '127.0.0.1', r));
  await assert.rejects(run(), /already in use/);
  assert.equal(blocker.listening, true);
  console.log('PASS first-run server startup, checkout paths with spaces, config preservation and occupied-port refusal');
} finally {
  if (blocker?.listening) await new Promise(r => blocker.close(r));
  await fs.rm(dir, { recursive: true, force: true });
}
