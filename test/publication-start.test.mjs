import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile('server/index.js', 'utf8');
const entry = { id: 'turn', key: 'turn-queue:app' };
const updates = [];
let state = 'publishing', claims = 0;
const context = {
  updateTurn: async (_, value) => updates.push(value),
  cluster: { self: { id: 'owner' }, queue: async () => {
    claims++;
    return { entries: [{ id: entry.id, state }] };
  } },
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('async function awaitPublication('), source.indexOf('function queueSummary(')), context);
await context.awaitPublication(entry);
assert.deepEqual(updates, ['ready']);
assert.equal(claims, 1);
state = 'ready';
await assert.rejects(context.awaitPublication(entry), /Restart Harness on all paired computers/, 'old coordinators report incompatibility instead of waiting forever');
const stopped = new AbortController();
stopped.abort();
const before = claims;
await assert.rejects(context.awaitPublication(entry, stopped.signal), /abort/i);
assert.equal(claims, before);
console.log('PASS publication starts immediately, cancellation is respected and old coordinators fail with restart guidance');
