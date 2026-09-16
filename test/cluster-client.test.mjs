import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile('server/public/cluster-client.js', 'utf8');
const storage = new Map([
  ['orchestrator-viewer', 'viewer-1234567890123456'], ['lastSession', 'session-1'],
  ['orchestrator-cluster', JSON.stringify({ id: 'group', ticket: 'signed-ticket', hosts: [
    { id: 'dead', member: true, url: 'https://dead.test' },
    { id: 'survivor', member: true, url: 'https://survivor.test' },
    { id: 'unapproved', member: false, url: 'https://unapproved.test' },
  ] })],
]);
const listeners = {}, calls = []; let interval, moved;
const document = { hidden: false, addEventListener: (name, fn) => { listeners[name] = fn; },
  getElementById: () => ({ value: 'unsent draft' }) };
const fetch = async (url, options) => {
  calls.push({ url, options });
  if (url === '/api/cluster/viewer') throw Error('host down');
  return { json: async () => ({ id: 'group', ready: true }) };
};
const window = { fetch, addEventListener: (name, fn) => { listeners[name] = fn; }, isSecureContext: true };
vm.runInNewContext(source, { window, document, navigator: {},
  localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  crypto: { randomUUID: () => 'new-viewer-123456789' },
  location: { search: '', origin: 'https://dead.test', hash: '', replace: (url) => { moved = new URL(url); } },
  URL, URLSearchParams, AbortSignal, setInterval: (fn) => { interval = fn; }, history: {},
});
await interval(); await interval(); assert.equal(moved, undefined);
await interval();
assert.equal(moved.origin, 'https://survivor.test');
assert.equal(moved.searchParams.get('session'), 'session-1');
assert.equal(moved.searchParams.get('t'), 'signed-ticket');
assert.equal(decodeURIComponent(moved.hash), '#draft=unsent draft');
assert.equal(calls.some((c) => /unapproved|\/send/.test(c.url)), false);
assert.equal(calls.filter((c) => c.url.includes('/health')).length, 1);
const sw = await fs.readFile('server/public/sw.js', 'utf8');
assert.match(sw, /if \(!ASSETS.includes\(asset\)\) return/);
assert.match(sw, /AbortSignal.timeout\(3000\)/);
console.log('PASS browser failover only probes approved hosts, preserves draft/session and never replays sends');
