import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createCluster } from '../src/core/cluster/index.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cluster-http-'));
const servers = [], nodes = [];
async function host(name) {
  let cluster;
  const server = http.createServer(async (req, res) => {
    try {
      if (!cluster.trusted(req) && req.headers['x-harness-token'] !== 'test-token') { res.writeHead(403); return res.end('{}'); }
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks));
      let result = {};
      if (req.url.endsWith('/rpc')) result = await cluster.replica.receive(body);
      if (req.url.endsWith('/admit')) result = await cluster.admit(body.member);
      if (req.url.endsWith('/activate')) await cluster.activate(body.member);
      if (req.url.endsWith('/turn-queue')) result = await cluster.queue(body.key, body.action);
      if (req.url.endsWith('/command')) await cluster.replica.propose(body);
      res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); servers.push(server);
  cluster = await createCluster(path.join(root, name), { port: server.address().port });
  await cluster.setUrl(`http://127.0.0.1:${server.address().port}`);
  cluster.replica.start(); nodes.push(cluster); return cluster;
}
try {
  const a = await host('a'), b = await host('b');
  await a.command({ type: 'session', id: 's', value: { id: 's', events: ['original'] } });
  await b.join({ url: a.self.url, token: 'test-token', ownUrl: b.self.url });
  await a.replica.replicate();
  assert.equal(a.status().hosts.length, 2); assert.equal(b.status().hosts.length, 2);
  assert.equal(b.replica.state.sessions.s.events[0], 'original');
  assert.equal(b.verifyTicket(a.ticket()), true);
  assert.equal(b.verifyTicket(a.ticket() + 'x'), false);
  await Promise.all([a.queue('turn-queue:project', { op: 'enqueue', entry: { id: 'first', sessionId: 'one', owner: a.self.id } }), b.queue('turn-queue:project', { op: 'enqueue', entry: { id: 'second', sessionId: 'two', owner: b.self.id } })]);
  assert.deepEqual((await b.queue('turn-queue:project')).entries.map(e => e.number), [1, 2]);
  const c = await host('c');
  await c.join({ url: a.self.url, token: 'test-token', ownUrl: c.self.url });
  await a.replica.replicate();
  assert.equal((await c.queue('turn-queue:project')).entries.length, 2, 'joining machines inherit the durable queue');
  assert.equal(c.status().mode, 'majority consensus');
  assert.equal(c.status().quorum, 2);
  await b.viewer({ id: 'viewer-test-123456789' }, 'iPhone'); await a.replica.replicate();
  assert.equal(c.status().viewers.length, 1);
  assert.equal(c.status().viewers[0].kind, 'phone');
  console.log('PASS real HTTP onboarding one → two → three, cross-host viewers, and tickets');
} finally {
  for (const node of nodes) node.replica.stop();
  for (const server of servers) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  await fs.rm(root, { recursive: true, force: true });
}
