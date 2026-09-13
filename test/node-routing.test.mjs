// Two real servers, with isolated data and different tokens, no live state.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-routing-'));
const processes = [];
async function start(name) {
  const port = await new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const dir = path.join(temp, name);
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify({ default: 'mock', models: { mock: { provider: 'openai', model: 'mock', baseUrl: 'http://127.0.0.1:1/v1' } } }));
  const child = spawn(process.execPath, ['server/index.js'], { env: {
    ...process.env, HARNESS_DATA_DIR: dir, HARNESS_PORT: String(port), HARNESS_TOKEN: name,
  }, stdio: 'ignore' });
  processes.push(child);
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Test node exited');
    try { const r = await fetch(origin + '/api/node-info', { headers: { 'x-harness-token': name } }); if (r.ok) return { origin, name }; }
    catch { /* wait for socket */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Test node did not start');
}
async function call(node, route, body, method) {
  return fetch(node.origin + route, { method: method ?? (body ? 'POST' : 'GET'), headers: {
    'x-harness-token': node.name, 'content-type': 'application/json',
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
try {
  const a = await start('gateway'), b = await start('worker');
  assert.equal((await fetch(a.origin + '/api/nodes')).status, 401);
  const pairing = await call(a, '/api/nodes', { name: 'Worker', url: b.origin, token: b.name });
  assert.equal(pairing.status, 201);
  const paired = await pairing.json();
  assert.equal(paired.token, undefined);
  const prefix = `/api/nodes/${paired.id}`;
  const created = await call(a, prefix + '/api/sessions', { name: 'Remote', model: 'mock', projectDir: path.join(temp, 'project'), mode: 'chat' });
  assert.equal(created.status, 200);
  const session = await created.json();
  const workerState = await (await call(b, '/api/state')).json();
  const gatewayState = await (await call(a, '/api/state')).json();
  assert.ok(workerState.sessions.some((s) => s.id === session.id));
  assert.ok(!gatewayState.sessions.some((s) => s.id === session.id));
  const catalog = await (await call(a, '/api/nodes')).json();
  assert.equal(catalog[0].sessions[0].id, session.id);
  assert.equal((await call(a, prefix + '/api/nodes')).status, 403);
  const changed = await call(a, prefix + `/api/sessions/${session.id}`, { name: 'On worker' }, 'PATCH');
  assert.equal((await changed.json()).name, 'On worker');
  const source = await fs.readFile('server/public/app.js', 'utf8');
  const requests = [];
  const context = { location: { search: '?node=worker-1' }, URLSearchParams, encodeURIComponent,
    window: { fetch: (url) => { requests.push(url); return Promise.resolve({ json: async () => [] }); } } };
  vm.runInNewContext(source.slice(source.indexOf('const executionNode'), source.indexOf('const $ =')) +
    "fetch('/api/transcription'); fetch('/api/nodes'); globalThis.download = nodeApi('/api/file?path=x'); globalThis.key = sessionStorageKey;", context);
  assert.deepEqual(requests.slice(-2), ['/api/nodes/worker-1/api/transcription', '/api/nodes']);
  assert.equal(context.download, '/api/nodes/worker-1/api/file?path=x');
  assert.equal(context.key, 'lastSession:worker-1');
  console.log('PASS two-server authentication, remote session create/edit, catalog, UI routing and local isolation');
} finally {
  await Promise.all(processes.map(async (child) => {
    if (child.exitCode !== null) return;
    const done = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    await done; clearTimeout(timeout);
  }));
  await fs.rm(temp, { recursive: true, force: true });
}
