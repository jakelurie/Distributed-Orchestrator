import assert from 'node:assert/strict';
import { tailscaleCommand } from '../src/core/tailscale.js';
import { notificationSetupError } from '../src/core/notify.js';
import { commitAndPush } from '../src/core/git.js';
const fail = async () => { throw new Error('no daemon'); };
assert.deepEqual(await tailscaleCommand({}, 'darwin', fail), ['/Applications/Tailscale.app/Contents/MacOS/Tailscale']);
assert.deepEqual(await tailscaleCommand({ ORCHESTRATOR_TAILSCALE_SOCKET: '/explicit' }, 'darwin', fail), ['tailscale', '--socket', '/explicit']);
assert.deepEqual(await tailscaleCommand({ ORCHESTRATOR_TAILSCALE_SOCKET: '' }, 'darwin', fail), ['tailscale']);
assert.deepEqual(await tailscaleCommand({}, 'linux', fail), ['tailscale']);
assert.deepEqual(await tailscaleCommand({}, 'win32', fail), ['tailscale.exe']);
assert.deepEqual(await tailscaleCommand({}, 'darwin', async () => ({ stdout: '{"BackendState":"Running"}' })), ['/Applications/Tailscale.app/Contents/MacOS/Tailscale']);
assert.match(notificationSetupError({ enabled: true, kind: 'sms' }), /Settings → Notifications/);
assert.equal(notificationSetupError({ enabled: false, kind: 'sms' }), null);
assert.equal(notificationSetupError({ enabled: true, kind: 'sms', gmailUser: 'test', gmailPass: 'test' }), null);
const missing = await commitAndPush('/nonexistent-orchestrator-test-directory', { autoCreatePrivate: true });
assert.equal(missing.ok, false);
assert.match(missing.error, /Project folder is missing/);
console.log('PASS platform detection, explicit overrides, notification setup and missing Git folder diagnostics');

// A new project must still be able to turn automatic Git off before its first commit.
const { readFile } = await import('node:fs/promises');
const { runInNewContext } = await import('node:vm');
const source = await readFile(new URL('../server/public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function paintGit(session)');
const end = source.indexOf('\nasync function ', start + 1);
const gitSource = source.slice(start, end);
let html = '';
const box = {
  set innerHTML(value) { html = value; },
  insertAdjacentHTML(position, value) { html = value + html; },
  querySelectorAll() { return []; },
};
const paint = runInNewContext(gitSource + '\npaintGit;', {
  $: (id) => id === 's-git' ? box : null,
  api: async () => ({ repo: false, enabled: true }),
  esc: (s) => s, shortDir: (s) => s,
});
await paint({ id: 'test', projectDir: '/new/project' });
assert.match(html, /data-git="off"/);
assert.match(html, /data-git="on"/);
console.log('PASS Git controls remain available before repository creation');
