import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Replica, atomic } from '../src/core/cluster/raft.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-failover-'));
const machines = new Map(); const blocked = new Set();
let clock = 10000;
const laptop = { id: 'laptop', name: 'laptop', url: 'http://laptop' };
const pc = { id: 'pc', name: 'pc', url: 'http://pc' };
async function build(member, disk) {
  const dir = path.join(root, member.id);
  if (disk) await atomic(path.join(dir, 'replica.json'), { clusterId: 'test', secret: 'test', term: 0, votedFor: null, commit: 0, log: [], ...disk });
  const machine = new Replica(dir, { self: member, now: () => clock, random: () => 0,
    send: async (node, msg) => {
      if (blocked.has(member.id) || blocked.has(node.id)) throw Error('unreachable');
      return machines.get(node.id).receive(structuredClone(msg));
    } });
  machines.set(member.id, machine); await machine.init(); return machine;
}
async function run(machine, ms) { for (const end = clock + ms; clock < end; clock += 700) await machine.tick(); }
const leaders = () => [...machines.values()].filter((m) => m.role === 'leader' && !blocked.has(m.self.id));
try {
  // A join interrupted after its joint configuration committed used to need
  // both hosts forever: the survivor could never elect itself.
  const joint = { term: 14, votedFor: 'laptop', commit: 2, initial: [laptop], log: [
    { term: 1, id: 'e1', command: { type: 'noop' } },
    { term: 14, id: 'e2', command: { type: 'configuration', old: [laptop], members: [laptop, pc] } }] };
  let a = await build(laptop, joint);
  blocked.add('pc');
  await run(a, 8000);
  assert.equal(a.role, 'leader'); assert.equal(a.writable(), true, 'a lone survivor of an interrupted join takes over');
  await run(a, 1400);
  assert.equal(a.configuration().old, undefined, 'the main finishes the membership change');
  await a.propose({ type: 'session', id: 'tab4', value: { name: 'Tab 4' } });
  console.log('PASS interrupted join no longer blocks a lone host from becoming main');

  // The other host coming back follows the main; it does not force an election.
  blocked.clear();
  let b = await build(pc, { ...joint, votedFor: null, commit: 1, log: joint.log.slice(0, 1), initial: [laptop, pc] });
  await a.replicate(); await a.replicate();
  assert.deepEqual(b.state.sessions.tab4, { name: 'Tab 4' });
  const term = a.disk.term;
  for (let i = 0; i < 20; i++) { clock += 700; await b.tick(); await a.tick(); }
  assert.equal(a.role, 'leader'); assert.equal(a.disk.term, term, 'a returning host never deposes a healthy main');
  // Restarting the follower (a relaunch) is not disruptive either.
  b = await build(pc);
  clock += 9000; await b.tick(); await a.tick();
  assert.equal(a.role, 'leader'); assert.equal(b.role, 'follower'); assert.equal(a.disk.term, term);
  console.log('PASS a relaunched host rejoins as follower without disrupting the main');

  // Switching the follower off leaves the main writable: its tabs keep running.
  blocked.add('pc');
  await run(a, 10000);
  assert.equal(a.writable(), true);
  await a.propose({ type: 'session', id: 'tab4', value: { name: 'Tab 4', turn: 2 } });
  // Switching the main off hands over to the other host.
  blocked.clear(); await a.replicate();
  blocked.add('laptop');
  await run(b, 8000);
  assert.equal(b.role, 'leader'); assert.equal(b.writable(), true);
  assert.deepEqual(b.state.sessions.tab4, { name: 'Tab 4', turn: 2 });
  await b.propose({ type: 'session', id: 'tab5', value: { name: 'Tab 5' } });
  blocked.clear(); await b.replicate(); await b.replicate();
  assert.equal(a.role, 'follower'); assert.deepEqual(a.state.sessions.tab5, { name: 'Tab 5' });
  console.log('PASS either host switching off leaves the other as a writable main');

  // Both hosts starting an election at once: first come wins, never two mains.
  a.stepDown(a.disk.term); b.stepDown(b.disk.term);
  await Promise.all([a.campaign(), b.campaign()]);
  assert.ok(leaders().length <= 1, 'simultaneous candidates never both lead');
  for (let i = 0; i < 20 && leaders().length !== 1; i++) { clock += 700; await a.tick(); await b.tick(); }
  assert.equal(leaders().length, 1);
  console.log('PASS simultaneous start elects exactly one main');

  // Compaction keeps replica.json small and a host that missed the compacted
  // history catches up from a snapshot.
  const main = leaders()[0], other = main === a ? b : a;
  blocked.add(other.self.id);
  clock += 4000; await main.tick(); // past the window where it still counts as connected
  for (let i = 0; i < 100; i++) await main.propose({ type: 'value', id: 'n', value: i });
  assert.ok(main.disk.base > 50, 'committed history was compacted');
  assert.ok(main.disk.log.length < 64);
  blocked.clear(); for (let i = 0; i < 3; i++) await main.replicate();
  assert.equal(other.state.values.n, 99); assert.equal(other.disk.base, main.disk.base, 'caught up by snapshot');
  const restarted = await build(other.self);
  assert.equal(restarted.state.values.n, 99); assert.deepEqual(restarted.state.sessions.tab5, { name: 'Tab 5' });
  console.log('PASS log compaction, snapshot catch-up and restart from a snapshot');
} finally { await fs.rm(root, { recursive: true, force: true }); }
