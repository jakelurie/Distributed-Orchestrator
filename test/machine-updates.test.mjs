import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { harnessVersions } from '../src/core/harness-version.js';

const members = ['local', 'peer'].map(id => ({ id, name: id, url: `http://${id}` }));
const cluster = { self: members[0], replica: { members: () => members, disk: { secret: 'test' } } };
const local = { node: 'local', version: { revision: 'a' }, update: {} };
for (const update of [{ available: true, latest: 'b', skipped: 'busy' }, { restartRequired: true, head: 'b' }]) {
  const result = await harnessVersions(cluster, local, { request: async () => ({ ok: true,
    json: async () => ({ ...local, node: 'peer', busy: true, update }) }) });
  assert.equal(result.hosts[1].busy, true);
  assert.match(result.hosts[1].state, update.available ? /Update available: busy/ : /Restart needed/);
  assert.equal(result.aligned, false);
}

const source = await fs.readFile('server/public/app.js', 'utf8');
const code = source.slice(source.indexOf('async function restartOrchestrator('), source.indexOf('function renderAppsSheet('));
for (const host of ['local', 'peer']) {
  const calls = [];
  let reloaded = false, opened = false;
  const context = { Date, AbortSignal, encodeURIComponent,
    setTimeout: fn => fn(), closeSheet() {}, showBanner() {},
    location: { reload() { reloaded = true; } },
    harnessVersionSheet: async () => { opened = true; },
    api: async (route, options) => {
      calls.push([route, options?.method || 'GET']);
      if (route === '/api/harness/status') return { node: 'local' };
      assert.ok(route.endsWith('?host=' + host));
      return { node: host, restartId: 'ticket', instanceId: options?.method === 'POST' ? 'old' : 'new' };
    },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  await context.restartOrchestrator({}, host);
  assert.equal(calls.filter(call => call[1] === 'POST').length, 1);
  assert.equal(reloaded, host === 'local');
  assert.equal(opened, host === 'peer');
}
console.log('PASS per-machine updates, targeted restart requests and local versus remote reconnect');

const server = await fs.readFile('server/index.js', 'utf8');
const start = server.indexOf("    if (['/api/harness/status', '/api/harness/restart'].includes(pathname)");
const end = server.indexOf("    if (req.method === 'GET' && pathname === '/api/harness/status')", start);
const route = new Function('cluster', 'req', 'res', 'pathname', 'url', 'json', server.slice(start, end));
for (const operation of ['status', 'restart']) {
  const proxies = [];
  const service = { ...cluster, trusted: req => req.trusted,
    proxy: (req, res, host) => { proxies.push(host); return 'proxied'; } };
  const invoke = (host, trusted = false) => route(service, { trusted }, {}, '/api/harness/' + operation,
    new URL('http://local/api/harness/' + operation + '?host=' + host), (res, status) => status);
  assert.equal(invoke('peer'), 'proxied');
  assert.deepEqual(proxies, ['peer']);
  assert.equal(invoke('local'), undefined, 'local target continues to the local endpoint');
  assert.equal(invoke('unknown'), 404);
  assert.equal(invoke('peer', true), 409, 'a misrouted peer request cannot bounce between machines');
  assert.deepEqual(proxies, ['peer']);
}
console.log('PASS host routing selects one known machine and rejects unknown or misrouted targets');
