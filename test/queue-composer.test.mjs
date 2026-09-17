import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile('server/public/app.js', 'utf8');
const elements = { input: { value: 'follow up', style: {} }, queue: {}, send: {} };
const tab = { session: { id: 'active-tab' }, running: true };
const calls = [], banners = [];
const ctx = { $: id => elements[id], cur: () => tab, window: {}, pendingShots: [],
  showBanner: message => banners.push(message), setRunning: () => {}, paintPending: () => {},
  api: async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { queued: true }; },
};
vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('async function send('), source.indexOf('// ------------------------------------------------------------------ menus')), ctx);
await ctx.send(true);
assert.equal(calls[0].url, '/api/sessions/active-tab/queue');
assert.equal(calls[0].body.text, 'follow up');
assert.equal(elements.input.value, '');
assert.equal(elements.queue.disabled, false);
assert.match(banners.at(-1), /queued/);
elements.input.value = 'keep this draft';
ctx.api = async () => { throw Error('Queue full'); };
await ctx.send(true);
assert.equal(elements.input.value, 'keep this draft');
assert.equal(elements.queue.disabled, false);
assert.equal(banners.at(-1), 'Queue full');
const before = calls.length;
await ctx.send();
assert.equal(calls.length, before);
assert.match(banners.at(-1), /Queue next/);
const page = await fs.readFile('server/public/index.html', 'utf8');
assert.match(page, /id="queue"[^>]*hidden/);
assert.ok(page.indexOf('id="queue"') < page.indexOf('id="stop"'));
console.log('PASS busy composer queues to the current tab, keeps rejected drafts, and exposes a separate queue button');

elements.stop = {};
vm.runInContext(source.slice(source.indexOf('function paintComposerAction()'), source.indexOf('function setRunning(')), ctx);
for (const [running, text, shots, expected] of [
  [true, '', [], 'stop'], [true, 'hello', [], 'queue'],
  [true, '   ', [], 'stop'], [true, '', [{ path: '/image.png' }], 'queue'],
  [false, 'hello', [], 'send'],
]) {
  tab.running = running; elements.input.value = text; ctx.pendingShots = shots;
  ctx.paintComposerAction();
  assert.deepEqual(['send', 'stop', 'queue'].filter(id => !elements[id].hidden), [expected]);
}
console.log('PASS busy action switches Stop to Queue and back as draft content changes');
