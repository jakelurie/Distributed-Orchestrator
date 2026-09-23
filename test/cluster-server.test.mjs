import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cluster-server-'));
const hosts = [];
const pause = () => new Promise((r) => setTimeout(r, 150));
async function start(name) {
  const portCheck = net.createServer(); await new Promise((r) => portCheck.listen(0, '127.0.0.1', r));
  const port = portCheck.address().port; await new Promise((r) => portCheck.close(r));
  const dir = path.join(root, name); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify({ default: 'opus', models: { opus: { provider: 'openai', model: 'test', baseUrl: 'http://127.0.0.1:1/v1' } } }));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env,
    HARNESS_PORT: String(port), HARNESS_TOKEN: 'cluster-test', HARNESS_DATA_DIR: dir,
    ORCHESTRATOR_PUBLIC_URL: origin, ORCHESTRATOR_NODE_NAME: name,
  }, stdio: 'ignore' });
  const closed = once(child, 'exit');
  const call = async (route, method = 'GET', body) => {
    const response = await fetch(origin + route, { method, headers: { 'Content-Type': 'application/json', 'x-harness-token': 'cluster-test' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
  };
  const host = { child, closed, origin, call }; hosts.push(host);
  for (let i = 0; i < 60; i++) { try { await call('/api/cluster/status'); return host; } catch { await pause(); } }
  throw Error('Test server failed to start');
}
try {
  const a = await start('a'), b = await start('b'), c = await start('c');
  const publicInfo = await fetch(a.origin + '/api/cluster/pairing').then(r => r.json());
  assert.equal(publicInfo.service, 'distributed-orchestrator');
  assert.equal(publicInfo.pending, null);
  assert.ok(!JSON.stringify(publicInfo).includes('cluster-test'));
  const denied = await fetch(a.origin + '/api/cluster/pairing', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: 'wrong', token: 'wrong' }) });
  assert.equal(denied.status, 400, 'unsolicited pairing cannot initiate a join');
  const discoveryDenied = await fetch(a.origin + '/api/cluster/discover');
  assert.equal(discoveryDenied.status, 401, 'discovery requires local app access');
  const project = path.join(root, 'project'); await fs.mkdir(project); await fs.writeFile(path.join(project, 'reference.txt'), 'replicated');
  const session = await a.call('/api/sessions', 'POST', { name: 'shared', model: 'opus', projectDir: project });
  const invitation = await a.call('/api/cluster/invite', 'POST', {});
  await b.call('/api/cluster/join', 'POST', { url: a.origin, ownUrl: b.origin, token: invitation.code });
  const reused = await fetch(a.origin + '/api/cluster/admit', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-harness-token': invitation.code }, body: '{}' });
  assert.equal(reused.status, 401, 'join codes are one-use');
  await c.call('/api/cluster/join', 'POST', { url: a.origin, ownUrl: c.origin, token: 'cluster-test' });
  assert.equal((await b.call('/api/sessions/' + session.id)).name, 'shared');
  const target = (await a.call('/api/cluster/status')).hosts.find(h => h.name === 'b');
  const sources = await a.call('/api/cluster/sources', 'POST', { host: target.id, action: 'catalog' });
  assert.equal(sources.machine.id, target.id, 'source settings target the selected machine');
  assert.ok(!JSON.stringify(sources).includes('apiKey":'));
  const sourceDenied = await fetch(b.origin + '/api/cluster/worker-sources', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-harness-token': 'cluster-test' }, body: '{"action":"catalog"}' });
  assert.equal(sourceDenied.status, 403);
  await assert.rejects(a.call('/api/cluster/sources', 'POST', { host: 'missing', action: 'catalog' }));
  const help = await a.call('/api/machine-help', 'POST', { host: target.id, question: 'Which models are configured?' });
  assert.equal(help.machine.id, target.id);
  assert.ok(Array.isArray(help.models));
  const helpDenied = await fetch(b.origin + '/api/cluster/worker-help', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-harness-token': 'cluster-test' }, body: '{}' });
  assert.equal(helpDenied.status, 403, 'worker diagnostics require cluster authentication');
  const unknownHelp = await fetch(a.origin + '/api/machine-help', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-harness-token': 'cluster-test' }, body: JSON.stringify({ host: 'unknown' }) });
  assert.ok(!unknownHelp.ok, 'unknown hosts are never substituted');
  const mainProcess = await a.call('/api/harness/status');
  const followerProcess = await b.call('/api/harness/status');
  assert.notEqual(followerProcess.instanceId, mainProcess.instanceId, 'restart status identifies the addressed host, not the leader');
  assert.equal(followerProcess.pid, b.child.pid);
  await c.call('/api/cluster/viewer', 'POST', { id: 'test-phone-123456789' });
  await a.call('/api/sessions/' + session.id, 'PATCH', { name: 'replicated rename' });
  await a.call('/api/models/key', 'POST', { alias: '__transcription', apiKey: 'test-replicated-key' });
  const upload = await fetch(a.origin + '/api/sessions/' + session.id + '/upload', {
    method: 'POST', headers: { 'x-harness-token': 'cluster-test', 'x-filename': 'sample.txt' }, body: 'replicated attachment',
  });
  assert.equal(upload.status, 200); const attachment = await upload.json();
  assert.ok(attachment.clusterAsset);
  // Hard failure, not graceful shutdown: no last-second snapshot is possible.
  a.child.kill('SIGKILL'); await a.closed;
  let survivor;
  for (let i = 0; i < 100; i++) {
    for (const node of [b, c]) { if ((await node.call('/api/cluster/status')).writable) survivor = node; }
    if (survivor) break; await pause();
  }
  assert.ok(survivor, 'a surviving majority elects a coordinator');
  assert.equal((await survivor.call('/api/sessions/' + session.id)).name, 'replicated rename');
  assert.equal((await survivor.call('/api/cluster/status')).hosts.length, 3);
  assert.equal((await survivor.call('/api/cluster/status')).viewers.length, 0, 'localhost is not a viewer');
  const unavailable = await fetch(survivor.origin + '/api/sessions/' + session.id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-harness-token': 'cluster-test' }, body: JSON.stringify({ name: 'after crash' }) });
  assert.equal(unavailable.status, 503, 'an offline owner is never silently replaced for a mutation');
  assert.equal((await survivor.call('/api/transcription')).configured, true);
  const restored = await fetch(survivor.origin + '/api/file?path=' + encodeURIComponent(attachment.path), {
    headers: { 'x-harness-token': 'cluster-test' },
  });
  assert.equal(restored.status, 200); assert.equal(await restored.text(), 'replicated attachment');
  console.log('PASS three real servers: onboarding, proxy, replicated rename, viewer history, config, attachments and SIGKILL failover');
} finally {
  for (const host of hosts) { if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGTERM'); }
  await Promise.all(hosts.map((h) => h.closed));
  await fs.rm(root, { recursive: true, force: true });
}
