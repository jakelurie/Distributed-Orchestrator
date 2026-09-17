import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile('server/public/app.js', 'utf8');
const nodes = new Map();
const $ = (id) => {
  if (!nodes.has(id)) nodes.set(id, { querySelectorAll: () => [] });
  return nodes.get(id);
};
const calls = [], opened = [];
const state = { sessions: [{ id: 'one', appId: 'a', name: 'One' }, { id: 'two', appId: 'a', name: 'Two' }, { id: 'other', appId: 'b', name: 'Other' }], default: 'model' };
const context = { state, $, esc: String, sessionStorageKey: 'host', localStorage: { getItem: () => 'two' },
  openSession: async id => opened.push(id), api: async (url, opts) => { calls.push(JSON.parse(opts.body)); return { id: 'new', appId: 'empty' }; },
  showBanner: assert.fail, sessionOptionsSheet() {}, newSheet() {}, draft: {},
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function projectSession('), source.indexOf('function sessionOptionsSheet(')), context);
await context.openProject({ id: 'a' });
assert.equal(opened.at(-1), 'two');
state.session = state.sessions[0];
await context.openProject({ id: 'a' });
assert.equal(opened.at(-1), 'one');
await context.openProject({ id: 'empty', name: 'Empty' });
assert.deepEqual(calls[0], { appId: 'empty', name: 'Empty', model: 'model' });
await context.openProject({ id: 'empty', name: 'Empty' });
assert.equal(calls.length, 1);
context.paintSessionTabs();
assert.match($('session-tabs').innerHTML, /One/);
assert.match($('session-tabs').innerHTML, /Two/);
assert.doesNotMatch($('session-tabs').innerHTML, /Other/);
assert.match($('session-tabs').innerHTML, /aria-current="page"/);
$('session-add').onclick();
assert.equal(context.draft.appId, 'a');
state.session = null;
context.paintSessionTabs();
assert.equal($('session-tabs').hidden, true);
const card = source.slice(source.indexOf('  const appCard ='), source.indexOf('  const appsHtml'));
assert.doesNotMatch(card, /app-sessions|data-new-in/);
console.log('PASS app chat selection, empty app creation, scoped tabs and new-session app selection');
