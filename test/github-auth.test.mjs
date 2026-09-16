import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createGithubAuth, configureGithub, githubEnv } from '../src/core/github-auth.js';
import { loadSecrets } from '../src/core/secrets.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'github-test-'));
configureGithub(dir);
try {
  let launches = 0;
  const existing = createGithubAuth(dir, { run: async (_, args) => ({ stdout: args[0] === 'api' ? 'existing-user\n' : 'test-secret\n' }), launch: () => { launches++; } });
  assert.equal((await existing.status()).login, 'existing-user');
  assert.equal((await existing.start()).state, 'connected');
  assert.equal(launches, 0);
  assert.deepEqual(await loadSecrets(dir), {});
  assert.equal((await existing.shareExisting()).shared, true);
  assert.equal((await githubEnv()).GH_TOKEN, 'test-secret');
  assert.ok(Object.values(await githubEnv()).includes('!gh auth git-credential'));
  assert.ok(!JSON.stringify(await existing.status()).includes('test-secret'));
  await fs.rm(path.join(dir, 'secrets.json'));
  let child, loginEnv;
  const auth = createGithubAuth(dir, {
    run: async (_, args, options) => {
      if (args[0] === 'auth') return { stdout: 'new-test-secret' };
      if (options.env.GH_TOKEN === 'new-test-secret') return { stdout: 'new-user' };
      throw new Error('unauthenticated');
    },
    launch: (_, args, options) => {
      assert.ok(args.includes('--insecure-storage'));
      loginEnv = options.env;
      assert.notEqual(loginEnv.GH_CONFIG_DIR, process.env.GH_CONFIG_DIR);
      assert.equal(loginEnv.GH_TOKEN, undefined);
      child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new PassThrough(); child.kill = () => child.emit('close', 1);
      return child;
    },
  });
  assert.equal((await auth.status()).authenticated, false);
  assert.equal((await auth.start()).state, 'starting');
  child.stderr.write('First copy your one-time code: ABCD-1234\n');
  assert.equal(auth.progress().code, 'ABCD-1234');
  child.emit('close', 0);
  for (let i = 0; i < 100 && auth.progress().state !== 'ready'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(auth.progress().state, 'ready');
  assert.deepEqual(await loadSecrets(dir), {}); // no writes until explicit completion
  assert.ok(!JSON.stringify(auth.progress()).includes('new-test-secret'));
  assert.equal((await auth.finish()).login, 'new-user');
  assert.equal((await loadSecrets(dir)).__github, 'new-test-secret');
  for (let i = 0; i < 100 && await fs.stat(loginEnv.GH_CONFIG_DIR).catch(() => null); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(await fs.stat(loginEnv.GH_CONFIG_DIR).catch(() => null), null);
  console.log('PASS existing login preservation, system sharing, isolated browser flow, private status and cleanup');
} finally { configureGithub(null); await fs.rm(dir, { recursive: true, force: true }); }

// The browser exposes only the device code and public account status.
const { default: vm } = await import('node:vm');
const source = await fs.readFile('server/public/app.js', 'utf8');
let rendered, shared = false;
const nodes = new Map();
const calls = [];
const context = {
  $: (id) => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); },
  openSheet: (html) => { rendered = html; nodes.clear(); }, backToSettings: '', settingsSheet() {},
  api: async (url) => {
    calls.push(url);
    if (url.endsWith('/share')) shared = true;
    return url.endsWith('/login') ? { state: 'idle' } : { authenticated: true, login: 'existing-user', shared };
  },
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('async function githubSheet()'), source.indexOf('async function sessionSettingsSheet()')), context);
await context.githubSheet();
assert.match(rendered, /Edit session/);
assert.match(context.$('github-status').textContent, /existing host login preserved/);
assert.match(context.$('github-actions').innerHTML, /Use this connection across hosts/);
assert.ok(!calls.includes('/api/github/share'));
await context.$('github-connect').onclick();
assert.ok(calls.includes('/api/github/share'));
assert.match(context.$('github-status').textContent, /shared with paired hosts/);
console.log('PASS frontend preserves existing login until explicit system sharing');
