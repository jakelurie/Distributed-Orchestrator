import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-hosts-'));
const hosts = [];
const pause = () => new Promise(r => setTimeout(r, 150));
let release;
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: body.model }, finish_reason: null }] })}\n\n`);
  if (body.messages.at(-1)?.content === 'wait') await new Promise(r => { release = r; });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
async function start(name) {
  const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const dir = path.join(root, name); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify({ default: name, models: { [name]: {
    provider: 'openai', model: name, label: name, baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
  } } }));
  const origin = `http://127.0.0.1:${port}`;
  const launch = () => spawn(process.execPath, ['server/index.js'], { env: { ...process.env,
    HARNESS_PORT: String(port), HARNESS_TOKEN: 'execution-test', HARNESS_DATA_DIR: dir,
    ORCHESTRATOR_PUBLIC_URL: origin, ORCHESTRATOR_NODE_NAME: name,
  }, stdio: 'ignore' });
  const child = launch();
  const closed = once(child, 'exit');
  const request = (route, method = 'GET', body) => fetch(origin + route, { method,
    headers: { 'Content-Type': 'application/json', 'x-harness-token': 'execution-test' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const call = async (...args) => { const r = await request(...args); const v = await r.json(); assert.ok(r.ok, JSON.stringify(v)); return v; };
  const host = { child, closed, call, request, dir, restart: async () => {
    host.child = launch(); host.closed = once(host.child, 'exit');
    for (let i = 0; i < 60; i++) { try { await call('/api/cluster/status'); return; } catch { await pause(); } }
    throw Error('server did not restart');
  } }; hosts.push(host);
  for (let i = 0; i < 60; i++) { try { host.status = await call('/api/cluster/status'); return host; } catch { await pause(); } }
  throw Error('server did not start');
}
try {
  const a = await start('model-a'), b = await start('model-b');
  await b.call('/api/cluster/join', 'POST', { url: a.status.hosts[0].url, ownUrl: b.status.hosts[0].url, token: 'execution-test' });
  const state = await a.call('/api/state');
  assert.equal(state.apps.find(app => app.id === '__harness').executionHosts.length, 2);
  const s = await a.call('/api/sessions', 'POST', { appId: '__harness', name: 'remote', mode: 'chat', model: 'model-b', ownerNode: b.status.self });
  const inventory = await a.call(`/api/sessions/${s.id}/models`);
  assert.deepEqual(Object.keys(inventory.models), ['model-b'], 'models stay local to the owner');
  const events = await a.request(`/api/sessions/${s.id}/events`);
  const reader = events.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /hello/);
  await reader.cancel();
  await a.call(`/api/sessions/${s.id}/send`, 'POST', { text: 'wait' });
  for (let i = 0; i < 80 && !release; i++) await pause();
  assert.ok(release, 'a follower executed the model request');
  assert.ok((await a.call('/api/state')).running.includes(s.id));
  assert.equal((await a.request(`/api/sessions/${s.id}/machine`, 'POST', { ownerNode: a.status.self })).status, 409);
  const parallel = await a.call('/api/sessions', 'POST', { appId: '__harness', name: 'parallel', mode: 'chat', model: 'model-a', ownerNode: a.status.self });
  await b.call(`/api/sessions/${parallel.id}/send`, 'POST', { text: 'hello' });
  let parallelResult;
  for (let i = 0; i < 80; i++) {
    parallelResult = await a.call(`/api/sessions/${parallel.id}`);
    if (!parallelResult.turnHost && parallelResult.events.some(e => e.type === 'assistant')) break;
    await pause();
  }
  assert.ok(parallelResult.events.some(e => e.type === 'assistant'));
  assert.ok((await a.call('/api/state')).running.includes(s.id), 'another tab completes while the first is busy');
  assert.equal((await a.call('/api/state')).projectQueues, undefined);
  release();
  let finished;
  for (let i = 0; i < 80; i++) {
    finished = await a.call(`/api/sessions/${s.id}`);
    if (!finished.turnHost) break;
    await pause();
  }
  assert.ok(!finished.turnHost);
  assert.equal(finished.ownerNode, b.status.self);
  assert.ok(finished.events.some(e => e.type === 'assistant' && e.text === 'model-b'));
  assert.equal((await a.request(`/api/sessions/${s.id}/rewind`, 'POST', { eventId: finished.events[0].id, revertFiles: true })).status, 409, 'file rewind cannot bypass publication order');
  const stale = structuredClone(finished);
  const moved = await a.call(`/api/sessions/${s.id}/machine`, 'POST', { ownerNode: a.status.self });
  assert.equal(moved.ownerNode, a.status.self);
  assert.equal(moved.model, 'model-a');
  // Test only synthetic credentials in this test's temporary directory.
  const identity = JSON.parse(await fs.readFile(path.join(a.dir, 'cluster', 'replica.json'), 'utf8'));
  const late = await fetch(a.status.hosts[0].url + '/api/cluster/worker-save', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cluster-key': identity.secret },
    body: JSON.stringify({ host: b.status.self, session: stale }) });
  assert.equal(late.status, 409, 'a delayed previous-owner write cannot undo assignment');
  assert.equal((await a.call(`/api/sessions/${s.id}`)).ownerNode, a.status.self);
  assert.equal((await a.request('/api/cluster/worker-save', 'POST', { host: a.status.self, session: moved })).status, 403);
  // A restarted worker may never have been offline long enough for the
  // coordinator's liveness timeout. Simulate its persisted abandoned turn.
  const abandoned = { ...stale, id: 'abandoned-worker-turn', turnHost: b.status.self,
    turnStartedAt: 123, executionEpoch: 0 };
  const seeded = await fetch(a.status.hosts[0].url + '/api/cluster/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cluster-key': identity.secret },
    body: JSON.stringify({ type: 'session', id: abandoned.id, value: abandoned }),
  });
  assert.equal(seeded.status, 200);
  let recovered;
  for (let i = 0; i < 80; i++) {
    recovered = await a.call('/api/sessions/' + abandoned.id);
    if (!recovered.turnHost) break;
    await pause();
  }
  assert.ok(!recovered.turnHost, 'an online worker recovers its own abandoned turn');
  assert.equal(recovered.executionEpoch, 1);
  assert.equal(recovered.ownerNode, b.status.self);
  assert.ok(recovered.events.some(e => /nothing was automatically published or replayed/.test(e.text || '')));
  assert.equal((await a.call('/api/sessions/' + s.id)).ownerNode, a.status.self);
  const project = await a.call('/api/apps', 'POST', { name: 'local only', dir: path.join(root, 'local-project'), hosts: [a.status.self] });
  const disallowed = await b.request('/api/sessions', 'POST', { appId: project.id, model: 'model-b', ownerNode: b.status.self });
  assert.equal(disallowed.status, 400);
  const local = await b.call('/api/sessions', 'POST', { appId: project.id, mode: 'chat', model: 'model-a' });
  assert.equal(local.ownerNode, a.status.self, 'another computer can create a tab on the only enabled owner');
  assert.equal((await b.call(`/api/sessions/${local.id}/models`)).default, 'model-a');
  await b.call(`/api/sessions/${local.id}/send`, 'POST', { text: 'hello' });
  for (let i = 0; i < 80; i++) {
    const value = await b.call(`/api/sessions/${local.id}`);
    if (!value.turnHost) { assert.ok(value.events.some(e => e.text === 'model-a')); break; }
    await pause();
  }
  assert.equal((await a.request(`/api/sessions/${local.id}/machine`, 'POST', { ownerNode: b.status.self })).status, 409);
  // Legacy durable queue values cannot block new turns or replay old requests.
  const legacy = await fetch(a.status.hosts[0].url + '/api/cluster/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cluster-key': identity.secret },
    body: JSON.stringify({ type: 'value', id: 'turn-queue:__harness', value: { next: 2, entries: [
      { id: 'old', sessionId: s.id, owner: a.status.self, state: 'blocked', number: 1 },
    ] } }),
  });
  assert.equal(legacy.status, 200);
  await a.call(`/api/sessions/${s.id}/send`, 'POST', { text: 'continue without a queue' });
  for (let i = 0; i < 80; i++) {
    const value = await a.call(`/api/sessions/${s.id}`);
    if (!value.turnHost && value.events.some(e => e.text === 'continue without a queue')
      && !(await a.call('/api/state')).running.includes(s.id)) break;
    await pause();
  }
  await a.call(`/api/sessions/${s.id}`, 'DELETE');
  console.log('PASS follower-owned turns, local model inventories, SSE proxy, busy assignment guard, single-host eligibility and commands from another computer');
} finally {
  release?.();
  for (const h of hosts) if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill('SIGTERM');
  await Promise.all(hosts.map(h => h.closed));
  mock.closeAllConnections(); await new Promise(r => mock.close(r));
  await fs.rm(root, { recursive: true, force: true });
}
