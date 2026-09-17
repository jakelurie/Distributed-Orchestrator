import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile('server/public/app.js', 'utf8');
const nodes = { input: { value: '' } };
const t = { running: true, session: { id: 'one', events: [] } };
let fetchSession;
const paints = [];
const context = {
  cur: () => t, pendingShots: [],
  tabs: { chat: t }, state: { tab: 'chat', session: t.session },
  $: id => nodes[id] ??= {},
  drawTranscript: () => paints.push(t.running), clearLive() {}, paintSessionTabs() {},
  showBanner: assert.fail, nodeApi: x => x,
  setInterval: () => 1, clearInterval() {},
  EventSource: class { close() {} },
  api: async url => url === '/api/state' ? { running: [] } : fetchSession(),
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function paintComposerAction('), source.indexOf('async function send(')), context);
vm.runInContext(source.slice(source.indexOf('async function refreshState('), source.indexOf('function modelOptions(')), context);
const flush = () => new Promise(resolve => setImmediate(resolve));
fetchSession = async () => { throw new Error('offline'); };
context.listen('chat', 'one');
t.stream.onmessage({ data: JSON.stringify({ kind: 'hello', running: false }) });
await flush();
assert.equal(nodes.send.hidden, false);
assert.equal(nodes.working.hidden, true);
assert.equal(paints.at(-1), false, 'reconnect redraws stale working progress immediately');
assert.equal(t.needsTranscript, true);
fetchSession = async () => ({ id: 'one', events: [{ type: 'assistant', text: 'Final answer' }] });
await context.refreshState();
await flush();
assert.equal(t.session.events[0].text, 'Final answer', 'idle reconciliation retries missed reply');
assert.equal(t.needsTranscript, false);
// A delayed snapshot must not replace a newly selected session.
let resolve;
fetchSession = () => new Promise(r => { resolve = r; });
t.needsTranscript = true;
const pending = context.recoverTranscript('chat');
const other = { id: 'two', events: [] };
t.session = context.state.session = other;
resolve({ id: 'one', events: [] });
await pending;
assert.equal(t.session, other);
// Nor may a snapshot discard an event arriving while it was in flight.
const next = context.recoverTranscript('chat');
other.events.push({ text: 'new event' });
resolve({ id: 'two', events: [] });
await next;
assert.equal(t.session.events.length, 1);
assert.equal(t.needsTranscript, true);
// Polling without a reconnect repairs the same missed completion.
t.needsTranscript = false;
t.running = true;
fetchSession = async () => ({ id: 'two', events: [{ text: 'Completed' }] });
await context.refreshState();
await flush();
assert.equal(t.running, false);
assert.equal(t.session.events[0].text, 'Completed');
assert.equal(paints.at(-1), false);
console.log('PASS reconnect status, missed final reply retry, session switching and live-event races');
