import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/core/store.js';
import { Replica, atomic } from '../src/core/cluster/raft.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-cluster-'));
const members = ['a', 'b', 'c'].map((id) => ({ id, name: id, url: `http://${id}`, joinedAt: 1 }));
const machines = new Map(); const blocked = new Set();
let clock = 10000;
async function build(member, initial = members) {
  const dir = path.join(root, member.id);
  await atomic(path.join(dir, 'replica.json'), { clusterId: 'test', secret: 'test', term: 0,
    votedFor: null, commit: 0, log: [], initial });
  const machine = new Replica(dir, { self: member, now: () => clock, random: () => 0,
    send: async (node, msg) => {
      if (blocked.has(member.id) || blocked.has(node.id)) throw Error('unreachable');
      return machines.get(node.id).receive(structuredClone(msg));
    } });
  machines.set(member.id, machine); await machine.init(); return machine;
}
try {
  const a = await build(members[0]); const b = await build(members[1]); const c = await build(members[2]);
  await a.campaign(); assert.equal(a.role, 'leader');
  await a.propose({ type: 'session', id: 's', value: { events: ['hello'] } });
  await a.replicate();
  assert.deepEqual(b.state.sessions.s, a.state.sessions.s);
  assert.deepEqual(c.state.sessions.s, a.state.sessions.s);
  store.useCluster({ shared: () => true, self: members[1], replica: b, saveSession: () => { throw Error('Coordinator lost quorum'); } });
  await assert.rejects(store.save({ id: 's', events: ['stale'] }), /quorum/);
  store.useCluster(null);
  assert.deepEqual(a.state.sessions.s.events, ['hello']);
  blocked.add('a'); clock += 10000;
  await b.campaign(); assert.equal(b.role, 'leader');
  await b.propose({ type: 'session', id: 's', value: { events: ['hello', 'after failover'] } });
  await b.replicate();
  assert.equal(a.writable(), false);
  await assert.rejects(a.propose({ type: 'session', id: 'bad', value: {} }), /quorum/);
  blocked.clear(); await b.replicate(); await b.replicate();
  assert.equal(a.role, 'follower'); assert.deepEqual(a.state.sessions.s, b.state.sessions.s);
  // A restarted voter must retain its term, vote and replicated transcripts.
  const restored = new Replica(a.dir, { self: members[0], send: a.send, now: () => clock });
  await restored.init(); assert.equal(restored.disk.term, a.disk.term);
  assert.deepEqual(restored.state.sessions.s, b.state.sessions.s);
  blocked.add('a'); blocked.add('c'); clock += 10000; await b.tick();
  assert.equal(b.writable(), false, 'a minority cannot write');
  assert.equal(b.role, 'follower');
  console.log('PASS majority election, replication, failure, minority fencing, catch-up and durable restart');
  // Two-host availability: a surviving machine takes over without the other.
  machines.clear(); blocked.clear(); clock += 10000;
  const x = { id: 'x', url: 'http://x' }, y = { id: 'y', url: 'http://y' };
  const first = await build(x, [x, y]), second = await build(y, [x, y]);
  await first.campaign(); await first.propose({ type: 'value', id: 'demo', value: 1 }); await first.replicate();
  blocked.add('x'); clock += 10000; await second.campaign();
  await second.propose({ type: 'value', id: 'demo', value: 2 });
  assert.equal(second.state.values.demo, 2);
  blocked.clear(); await second.replicate(); await second.replicate();
  assert.equal(first.state.values.demo, 2);
  console.log('PASS two-host automatic takeover and reconnection');
} finally { await fs.rm(root, { recursive: true, force: true }); }
