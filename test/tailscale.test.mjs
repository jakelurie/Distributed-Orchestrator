import assert from 'node:assert/strict';
import { tailscaleCommand, phoneRoute, networkStatus, configurePhoneAccess } from '../src/core/tailscale.js';
const execute = async (binary) => ({ stdout: JSON.stringify({ BackendState: binary === 'tailscale' ? 'Running' : 'NeedsLogin' }) });
assert.deepEqual(await tailscaleCommand({}, 'darwin', execute), ['tailscale']);
assert.deepEqual(await tailscaleCommand({}, 'darwin', async () => ({ stdout: '{"BackendState":"Running"}' })), ['/Applications/Tailscale.app/Contents/MacOS/Tailscale']);
assert.deepEqual(await tailscaleCommand({ ORCHESTRATOR_TAILSCALE_BIN: '/custom', ORCHESTRATOR_TAILSCALE_SOCKET: '/socket' }), ['/custom', '--socket', '/socket']);
const config = { TCP: { '443': { HTTPS: true } }, Web: { 'host.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } } } } };
assert.equal(phoneRoute(config, 8787), 'https://host.ts.net/');
assert.equal(phoneRoute(config, 8788), '');
assert.equal(phoneRoute({ ...config, AllowFunnel: { 'host.ts.net:443': true } }, 8787), '');
assert.equal(phoneRoute({ ...config, TCP: {} }, 8787), '');
let calls = [];
let serving = {};
const run = async (args) => {
  calls.push(args);
  if (args[0] === 'status') return { stdout: '{"BackendState":"Running"}' };
  if (args[1] === 'status') return { stdout: JSON.stringify(serving) };
  const port = args[2].split('=')[1];
  serving.TCP ||= {}; serving.Web ||= {};
  serving.TCP[port] = { HTTPS: true };
  serving.Web[`host.ts.net:${port}`] = { Handlers: { '/': { Proxy: args[3] } } };
  return { stdout: '' };
};
assert.equal((await networkStatus(8787, run)).connected, true);
assert.ok(calls.every((a) => a.includes('status')), 'status is read-only');
assert.equal((await configurePhoneAccess(8787, run)).phoneUrl, 'https://host.ts.net/');
calls = [];
await configurePhoneAccess(8787, run);
assert.ok(calls.every((a) => a.includes('status')), 'setup is idempotent');
serving = structuredClone(config);
const next = await configurePhoneAccess(8788, run);
assert.equal(next.phoneUrl, 'https://host.ts.net:8443/');
assert.deepEqual(serving.Web['host.ts.net:443'], config.Web['host.ts.net:443'], 'existing route preserved');
const down = await configurePhoneAccess(8787, async (args) => {
  assert.equal(args[0], 'status'); return { stdout: '{"BackendState":"NeedsLogin"}' };
});
assert.equal(down.connected, false);
assert.equal((await networkStatus(8787, async () => ({ stdout: JSON.stringify({ BackendState: 'Running', Self: { Online: false } }) }))).connected, false, 'a running daemon that reports this host offline is not connected');
assert.match(down.message, /sign in/);
assert.match((await networkStatus(8787, async () => { throw Error('missing'); })).message, /Install/);
serving = {};
const approval = await configurePhoneAccess(8787, async (args) => {
  if (args.includes('status')) return run(args);
  throw Object.assign(Error('timeout'), { stderr: 'Enable HTTPS: https://login.tailscale.com/f/serve-approval' });
});
assert.equal(approval.approvalUrl, 'https://login.tailscale.com/f/serve-approval');
assert.equal(approval.ready, false);
console.log('PASS standard clients, overrides, login, private routes, conflicts, idempotence and HTTPS approval');

// Exercise the settings flow: check, explicit setup, then display verified URL.
const { readFile } = await import('node:fs/promises');
const { runInNewContext } = await import('node:vm');
const source = await readFile(new URL('../server/public/app.js', import.meta.url), 'utf8');
const sheet = source.slice(source.indexOf('async function networkSheet()'), source.indexOf('async function machinesSheet()'));
const elements = {};
const element = () => ({ style: {}, children: [], append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; } });
const requests = [];
const show = runInNewContext(sheet + '\nnetworkSheet;', {
  openSheet(html) {
    assert.match(html, /Get Tailscale/);
    for (const id of ['network-status', 'network-check', 'network-setup', 'sub-back']) elements[id] = element();
  },
  $: (id) => elements[id], settingsSheet() {}, backToSettings: '',
  document: { createElement: element, createTextNode: (text) => text },
  api: async (url, options) => {
    requests.push({ url, options });
    return { connected: true, ready: options?.method === 'POST', message: 'test', localUrl: 'http://127.0.0.1:8787', phoneUrl: options?.method === 'POST' ? 'https://host.ts.net/' : '' };
  },
});
await show();
assert.equal(elements['network-setup'].disabled, false);
assert.equal(requests.length, 1, 'opening settings only reads status');
await elements['network-setup'].onclick();
assert.equal(requests[1].options.method, 'POST');
assert.equal(elements['network-setup'].disabled, true);
assert.match(JSON.stringify(elements['network-status'].children), /https:\/\/host.ts.net\//);
console.log('PASS settings check, explicit setup and phone link rendering');
