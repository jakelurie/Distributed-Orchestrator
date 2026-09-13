import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createNodes } from '../src/core/nodes.js';
import { addModel, loadConfig } from '../src/core/config.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-nodes-'));
let requests = [];
const remote = http.createServer(async (req, res) => {
  const parts = []; for await (const c of req) parts.push(c);
  requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(parts).toString() });
  if (req.headers['x-harness-token'] !== 'peer-secret') { res.writeHead(401); return res.end(); }
  if (req.url === '/api/node-info') return res.end(JSON.stringify({ protocol: 1, authenticated: true }));
  if (req.url === '/api/state') return res.end(JSON.stringify({ sessions: [{ id: 'remote-session' }], models: {}, running: [] }));
  if (req.url === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Set-Cookie': 'bad=1' });
    res.write('data: hello\n\n');
    return setTimeout(() => res.end('data: done\n\n'), 20);
  }
  res.end(Buffer.concat(parts));
});
await new Promise((r) => remote.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${remote.address().port}`;
const nodes = createNodes(dir);
let gateway;
try {
  await assert.rejects(nodes.add({ name: 'wrong', url, token: 'wrong' }));
  const node = await nodes.add({ name: 'PC', url, token: 'peer-secret' });
  assert.equal(node.token, undefined);
  assert.equal((await nodes.list())[0].token, undefined);
  assert.equal((await nodes.catalog())[0].sessions[0].id, 'remote-session');
  assert.equal(JSON.stringify(await nodes.catalog()).includes('peer-secret'), false);
  await assert.rejects(nodes.add({ name: 'duplicate', url, token: 'peer-secret' }));
  await assert.rejects(nodes.add({ name: 'bad', url: url + '/api', token: 'peer-secret' }));
  const restored = createNodes(dir);
  assert.equal((await restored.list())[0].id, node.id);
  assert.equal((await fs.stat(path.join(dir, 'nodes.json'))).mode & 0o777, 0o600);
  gateway = http.createServer((req, res) => { nodes.proxy(req, res, node.id, req.url).catch(() => res.destroy()); });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${gateway.address().port}`;
  const response = await fetch(root + '/api/upload?t=browser-secret', { method: 'POST', body: 'image bytes',
    headers: { 'x-harness-token': 'browser-secret', cookie: 'ht=browser-secret', 'x-filename': 'pic.png' } });
  assert.equal(await response.text(), 'image bytes');
  const forwarded = requests.at(-1);
  assert.equal(forwarded.url, '/api/upload');
  assert.equal(forwarded.headers['x-harness-token'], 'peer-secret');
  assert.equal(forwarded.headers.cookie, undefined);
  assert.equal(forwarded.headers['x-filename'], 'pic.png');
  const stream = await fetch(root + '/api/events');
  assert.equal(stream.headers.get('set-cookie'), null);
  assert.match(await stream.text(), /hello[\s\S]*done/);
  assert.equal((await fetch(root + '/api/nodes')).status, 403);
  assert.equal((await fetch(root + '/not-api')).status, 403);
  await new Promise((r) => remote.close(r));
  assert.equal((await nodes.catalog())[0].online, false);
  const before = requests.length;
  assert.equal((await fetch(root + '/api/send', { method: 'POST', body: 'never replay' })).status, 502);
  assert.equal(requests.length, before);
  await nodes.remove(node.id);
  assert.equal((await nodes.list()).length, 0);
  const mesh = createNodes(path.join(dir, 'mesh'), { request: async () => Response.json({ protocol: 1, authenticated: true }) });
  await Promise.all(Array.from({ length: 5 }, (_, i) => mesh.add({ name: `Machine ${i}`, url: `https://node-${i}.invalid`, token: 'test-only' })));
  assert.equal((await mesh.list()).length, 5, 'concurrent joins preserve all nodes beyond three');
  const alias = await addModel(dir, { label: 'GPU', model: 'local-model', provider: 'openai', baseUrl: 'http://100.100.100.100:11434/v1', apiKeyOptional: true });
  const config = await loadConfig(dir);
  assert.equal(config.models[alias].hasKey, true);
  assert.equal(config.models[alias].keyEnv, '');
  console.log('PASS pairing, persistence, secret isolation, upload routing, streaming, disconnects, no replay, GPU source');
} finally {
  remote.closeAllConnections(); remote.close();
  gateway?.closeAllConnections(); gateway?.close();
  await fs.rm(dir, { force: true, recursive: true });
}
