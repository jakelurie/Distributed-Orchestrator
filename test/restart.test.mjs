import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import vm from 'node:vm';

// An HTTP response from the old process must not count as a restart.
const source = await fs.readFile('server/public/app.js', 'utf8');
const code = source.slice(source.indexOf('async function restartOrchestrator('), source.indexOf('function renderAppsSheet('));
const binding = source.slice(source.indexOf("$('sheet').querySelectorAll('[data-harness-restart]')"), source.indexOf("$('sheet').querySelectorAll('[data-new-in]')"));
let click, invoked = 0;
vm.runInNewContext(binding, {
  $: () => ({ querySelectorAll: () => [{ set onclick(fn) { click = fn; } }] }),
  harnessVersionSheet: async () => { invoked++; },
});
await click({ stopPropagation() {} });
assert.equal(invoked, 1, 'the first tap opens the machine selector');
const expected = { instanceId: 'old', restartId: 'ticket', node: 'host' };
for (const scenario of ['success', 'timeout', 'refused', 'legacy']) {
  let now = 0, polls = 0, reloaded = false, closed = false;
  const banners = [];
  const button = {};
  const context = {
    Date: { now: () => now }, AbortSignal,
    setTimeout: (fn, ms) => { now += ms; fn(); },
    closeSheet: () => { closed = true; }, showBanner: text => banners.push(text),
    location: { reload: () => { reloaded = true; } },
    api: async (route) => {
      if (route.endsWith('/restart')) {
        if (scenario === 'refused') throw Error('A turn is still running');
        return scenario === 'legacy' ? { ok: true } : expected;
      }
      polls++;
      if (polls === 2) throw Error('connection refused');
      if (scenario === 'success' && polls === 4) return { ...expected, instanceId: 'new' };
      if (polls === 3) return { ...expected, instanceId: 'other', node: 'other-host' };
      return expected;
    },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  await context.restartOrchestrator(button);
  assert.equal(closed, true);
  assert.equal(button.disabled, false);
  assert.equal(reloaded, scenario === 'success');
  if (scenario === 'success') assert.equal(polls, 4);
  if (scenario === 'timeout') assert.match(banners.at(-1), /could not be verified/);
  if (scenario === 'refused') assert.match(banners.at(-1), /still running/);
  if (scenario === 'legacy') assert.match(banners.at(-1), /old server/);
}
console.log('PASS restart UI rejects old processes, other hosts, timeouts and refusals');

// Restart an isolated real server; never address the user's live server.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restart-server-'));
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env,
  HARNESS_PORT: String(port), HARNESS_TOKEN: 'restart-test', HARNESS_DATA_DIR: dir,
  ORCHESTRATOR_PUBLIC_URL: origin,
}, stdio: 'ignore' });
const exited = once(child, 'exit');
const call = async (route, method = 'GET', target = origin, body) => {
  const response = await fetch(target + route, { method,
    headers: { 'x-harness-token': 'restart-test', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200);
  return response.json();
};
const waitFor = async (predicate, target = origin) => {
  for (let i = 0; i < 120; i++) {
    try { const status = await call('/api/harness/status', 'GET', target); if (predicate(status)) return status; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Test server did not become ready');
};
let replacement, peer, peerClosed, peerReplacement;
try {
  const original = await waitFor(() => true);
  assert.equal(original.pid, child.pid);
  const peerProbe = net.createServer();
  await new Promise(resolve => peerProbe.listen(0, '127.0.0.1', resolve));
  const peerPort = peerProbe.address().port;
  await new Promise(resolve => peerProbe.close(resolve));
  const peerOrigin = `http://127.0.0.1:${peerPort}`;
  peer = spawn(process.execPath, ['server/index.js'], { env: { ...process.env,
    HARNESS_PORT: String(peerPort), HARNESS_TOKEN: 'restart-test', HARNESS_DATA_DIR: path.join(dir, 'peer'),
    ORCHESTRATOR_PUBLIC_URL: peerOrigin,
  }, stdio: 'ignore' });
  peerClosed = once(peer, 'exit');
  const peerOriginal = await waitFor(() => true, peerOrigin);
  await call('/api/cluster/join', 'POST', peerOrigin, { url: origin, ownUrl: peerOrigin, token: 'restart-test' });
  const peerRequested = await call('/api/harness/restart?host=' + peerOriginal.node, 'POST');
  peerReplacement = await waitFor(status => status.restartId === peerRequested.restartId, peerOrigin);
  assert.equal((await call('/api/harness/status')).instanceId, original.instanceId, 'restarting a peer leaves this machine running');
  assert.equal(peerReplacement.node, peerOriginal.node);
  assert.notEqual(peerReplacement.pid, peerOriginal.pid);
  await peerClosed;
  const requested = await call('/api/harness/restart', 'POST');
  assert.equal(requested.instanceId, original.instanceId);
  replacement = await waitFor(status => status.restartId === requested.restartId);
  assert.notEqual(replacement.pid, original.pid);
  assert.notEqual(replacement.instanceId, original.instanceId);
  assert.equal(replacement.node, original.node);
  await exited;
  // The replacement still serves the same app and data after the old parent exits.
  let state;
  for (let i = 0; i < 120; i++) {
    try { state = await call('/api/state'); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(state, 'the restarted cluster elects a coordinator and resumes serving state');
  assert.ok(Array.isArray(state.sessions));
  console.log('PASS real cluster restart replaces both PIDs, preserves identities and serves requests after the old processes exit');
} finally {
  if (peerReplacement) { try { process.kill(peerReplacement.pid, 'SIGTERM'); } catch {} }
  if (peer && peer.exitCode === null && peer.signalCode === null) peer.kill('SIGTERM');
  if (peerClosed) await peerClosed;
  if (replacement) { try { process.kill(replacement.pid, 'SIGTERM'); } catch {} }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await exited;
  await new Promise(resolve => setTimeout(resolve, 500));
  await fs.rm(dir, { recursive: true, force: true });
}
