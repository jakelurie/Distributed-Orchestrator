import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile('server/public/app.js', 'utf8');
const status = { textContent: '' };
const box = { innerHTML: '', querySelectorAll: () => [] };
const nodes = { 'notify-status': status, 's-notify': box, 'n-save': {}, 'n-test': {}, 'n-url': { value: 'https://example.test/topic' } };
let failure = false;
const context = {
  $: id => nodes[id], esc: String, showBanner: () => assert.fail('Feedback must stay inside settings'),
  api: async (url, options) => {
    if (failure && options) throw new Error('offline');
    if (url.endsWith('/test')) return { ok: true, via: 'webhook' };
    return { kind: 'webhook', enabled: true };
  },
};
vm.createContext(context);
const start = source.indexOf('async function paintNotify()');
vm.runInContext(source.slice(start, source.indexOf('\n/**', start)), context);
assert.match(source.slice(source.indexOf('function notifySheet()'), source.indexOf('function emailSheet()')), /id="notify-status"[^>]*role="status"/);
await context.paintNotify();
await nodes['n-save'].onclick();
assert.equal(status.textContent, 'Notification settings saved.');
await context.paintNotify();
assert.equal(status.textContent, 'Notification settings saved.', 'rerender preserves confirmation');
failure = true;
await nodes['n-save'].onclick();
assert.equal(status.textContent, 'Could not save: offline');
await nodes['n-test'].onclick();
assert.equal(status.textContent, 'test failed: offline');
assert.equal(nodes['n-test'].disabled, false);
failure = false;
await nodes['n-test'].onclick();
assert.equal(status.textContent, 'sent (webhook)');
console.log('PASS notification save and test feedback stays inside settings, including failures');
