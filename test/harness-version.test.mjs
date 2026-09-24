import assert from 'node:assert/strict';
import { harnessVersions } from '../src/core/harness-version.js';

const cluster = { self: { id: 'a' }, replica: { disk: { secret: 'test' }, members: () => [
  { id: 'a', name: 'Laptop' }, { id: 'b', name: 'Desktop', url: 'https://desktop.test' },
] } };
const local = { node: 'a', version: { revision: 'abc', committedAt: '2026-09-23', startedAt: '2026-09-24' }, update: {} };
let peer = { node: 'b', version: local.version };
const request = async (url, options) => {
  assert.equal(url.pathname, '/api/harness/status');
  assert.equal(options.headers['x-cluster-key'], 'test');
  assert.equal(options.redirect, 'error');
  return { ok: true, json: async () => peer };
};
assert.equal((await harnessVersions(cluster, local, { request })).aligned, true);
for (const [value, expected] of [
  [{ node: 'b' }, /Version unavailable/],
  [{ node: 'b', version: { revision: 'older' } }, /Different commit/],
  [{ node: 'b', version: local.version, update: { restartRequired: true } }, /Restart needed/],
  [{ node: 'b', version: { ...local.version, dirty: true } }, /Local edits/],
  [{ node: 'b', version: local.version, update: { error: 'fetch failed' } }, /Update check failed/],
  [{ node: 'b', version: local.version, update: { skipped: 'local changes' } }, /paused/],
  [{ node: 'wrong' }, /Unreachable/],
]) {
  peer = value;
  const result = await harnessVersions(cluster, local, { request });
  assert.equal(result.aligned, false);
  assert.match(result.hosts[1].state, expected);
  assert.equal(result.version.startedAt, local.version.startedAt);
}
assert.equal((await harnessVersions(cluster, local, { request: async () => { throw new Error('offline'); } })).aligned, false);
console.log('PASS running versions, timestamps, mismatches, restart prompts, older peers and offline machines');
