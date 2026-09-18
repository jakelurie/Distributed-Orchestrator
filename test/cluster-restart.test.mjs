import assert from 'node:assert/strict';
import { restartPeers } from '../src/core/cluster/restart.js';
import { createCluster } from '../src/core/cluster/index.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const members = ['local', 'desktop', 'laptop'].map(id => ({ id, name: id, url: `http://${id}` }));
const cluster = { self: members[0], replica: { members: () => members, disk: { secret: 'test-key' } } };
for (const scenario of ['success', 'busy', 'offline', 'refused', 'partial', 'lost-reply', 'timeout', 'wrong-host']) {
  let clock = 0;
  const calls = [], restarted = new Set(), polls = new Map();
  const request = async (url, options) => {
    const id = url.hostname, operation = url.pathname.split('/').at(-1);
    calls.push(`${id}:${operation}`);
    assert.equal(options.headers['x-cluster-key'], 'test-key');
    assert.equal(options.redirect, 'error');
    if (scenario === 'offline' && id === 'laptop') throw Error('offline');
    if (operation === 'restart') {
      if (scenario === 'refused' || (scenario === 'partial' && id === 'laptop'))
        return { ok: false, json: async () => ({ error: 'Work started' }) };
      if (scenario === 'lost-reply') throw Error('connection lost');
      restarted.add(id);
      return { ok: true, json: async () => ({ node: id, instanceId: 'old', restartId: 'ticket' }) };
    }
    let instanceId = 'old', restartId = null, node = id;
    if (restarted.has(id)) {
      const count = (polls.get(id) || 0) + 1;
      polls.set(id, count);
      if (count === 1) throw Error('restarting');
      if (scenario !== 'timeout') { instanceId = 'new'; restartId = 'ticket'; }
      if (scenario === 'wrong-host') node = 'other';
    }
    return { ok: true, json: async () => ({ node, instanceId, restartId, busy: scenario === 'busy' && id === 'laptop' }) };
  };
  const run = () => restartPeers(cluster, { request, sleep: async ms => { clock += ms; }, now: () => clock });
  if (scenario === 'success') {
    assert.deepEqual(await run(), ['desktop', 'laptop']);
    assert.deepEqual(calls.slice(0, 3), ['desktop:status', 'laptop:status', 'desktop:restart']);
    assert.ok(calls.indexOf('laptop:restart') > calls.lastIndexOf('desktop:status'));
  } else {
    await assert.rejects(run, scenario === 'partial' ? /Restart stopped at laptop:.*Already restarted: desktop/ : /Restart stopped at .*This computer has not restarted/);
    assert.equal(calls.filter(call => call.endsWith(':restart')).length, ['busy', 'offline'].includes(scenario) ? 0 : scenario === 'partial' ? 2 : 1);
  }
  assert.ok(!calls.some(call => call.startsWith('local:')));
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cluster-version-'));
try {
  const service = await createCluster(dir, { request: async () => ({ status: 404, ok: false,
    json: async () => ({ error: 'Unknown cluster operation' }) }) });
  service.replica.role = 'follower';
  service.replica.leader = service.self.id;
  service.self.url = 'http://old-desktop';
  // The persisted member is used to find the coordinator.
  service.leader = () => ({ url: 'http://old-desktop' });
  await assert.rejects(service.readSession('tab'), /running older Harness code.*read-session.*Restart Harness on every paired computer/);
} finally { await fs.rm(dir, { recursive: true, force: true }); }
console.log('PASS cluster restart preflight, sequential verification, failure handling, no replay and mixed-version diagnostics');
