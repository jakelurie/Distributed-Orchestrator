import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'network-gate-'));
const state = path.join(root, 'tailscale-state');
await fs.writeFile(state, 'Stopped');
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env,
  HARNESS_PORT: String(port), HARNESS_DATA_DIR: root, HARNESS_TOKEN: 'network-test',
  ORCHESTRATOR_TAILSCALE_BIN: path.resolve('test/fixtures/tailscale-connected.mjs'),
  ORCHESTRATOR_TAILSCALE_SOCKET: '', HARNESS_TEST_TAILSCALE_STATE: state,
}, stdio: 'ignore' });
const exited = once(child, 'exit');
const request = (route, method = 'GET') => fetch(`http://127.0.0.1:${port}${route}`, {
  method, headers: { 'x-harness-token': 'network-test', 'Content-Type': 'application/json' },
  ...(method === 'POST' ? { body: JSON.stringify({ name: 'blocked', text: 'hello' }) } : {}),
  signal: AbortSignal.timeout(5000),
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let network;
  for (let i = 0; i < 60; i++) {
    try { network = await (await request('/api/network')).json(); break; }
    catch { await pause(100); }
  }
  assert.equal(network.connected, false);
  assert.equal((await request('/')).status, 200, 'the blocking screen is still served');
  const blocked = await request('/api/sessions', 'POST');
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).code, 'TAILSCALE_DISCONNECTED');
  assert.equal((await request('/api/state')).status, 503);
  await fs.writeFile(state, 'Running');
  await pause(2200);
  assert.equal((await (await request('/api/network')).json()).connected, true);
  assert.equal((await request('/api/state')).status, 200, 'same process recovers without a restart');
  await fs.writeFile(state, 'Stopped');
  await pause(2200);
  assert.equal((await request('/api/state')).status, 503, 'disconnects close the gate again');
  console.log('PASS disconnected startup blocks API work, serves the error screen and recovers without restart');
} finally {
  child.kill('SIGTERM');
  await exited;
  await fs.rm(root, { recursive: true, force: true });
}
