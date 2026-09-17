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
vm.runInContext(source.slice(source.indexOf('function nextTabName('), source.indexOf('function sessionOptionsSheet(')), context);
await context.openProject({ id: 'a' });
assert.equal(opened.at(-1), 'two');
state.session = state.sessions[0];
await context.openProject({ id: 'a' });
assert.equal(opened.at(-1), 'one');
await context.openProject({ id: 'empty', name: 'Empty' });
assert.deepEqual(calls[0], { appId: 'empty', name: 'Tab 1', model: 'model' });
await context.openProject({ id: 'empty', name: 'Empty' });
assert.equal(calls.length, 1);
context.paintSessionTabs();
assert.match($('session-tabs').innerHTML, /One/);
assert.match($('session-tabs').innerHTML, /Two/);
assert.doesNotMatch($('session-tabs').innerHTML, /Other/);
assert.match($('session-tabs').innerHTML, /aria-current="page"/);
$('session-add').onclick();
assert.equal(context.draft.appId, 'a');
state.busy = ['two', 'other'];
context.paintSessionTabs();
assert.equal(($('session-tabs').innerHTML.match(/class="session-busy-dot"/g) ?? []).length, 1);
assert.match($('session-tabs').innerHTML, /Two<\/span><span class="session-busy-dot" role="img" aria-label="Working"/);
assert.doesNotMatch($('session-tabs').innerHTML, / · working/);
state.busy = [];
context.paintSessionTabs();
assert.doesNotMatch($('session-tabs').innerHTML, /session-busy-dot/);
const page = await fs.readFile('server/public/index.html', 'utf8');
assert.match(page, /id="working"/);
assert.match(page, /id="working-time"/);
state.sessions = [
  { id: 'newest', appId: 'a', name: 'Newest', createdAt: 300 },
  { id: 'oldest', appId: 'a', name: 'Oldest', createdAt: 100 },
  { id: 'middle', appId: 'a', name: 'Middle', createdAt: 200 },
];
state.session = state.sessions[0];
const tabIds = () => [...$('session-tabs').innerHTML.matchAll(/data-session-id="([^"]+)"/g)].map((m) => m[1]);
context.paintSessionTabs();
assert.deepEqual(tabIds(), ['oldest', 'middle', 'newest']);
assert.equal(state.sessions[0].id, 'newest', 'tab sorting leaves the browser list untouched');
state.sessions.reverse(); // A refresh can reorder summaries by recent activity.
context.paintSessionTabs();
assert.deepEqual(tabIds(), ['oldest', 'middle', 'newest']);
state.session = { id: 'added', appId: 'a', name: 'Added', createdAt: 400 };
context.paintSessionTabs();
assert.deepEqual(tabIds(), ['oldest', 'middle', 'newest', 'added']);
state.session = null;
context.paintSessionTabs();
assert.equal($('session-tabs').hidden, true);
const card = source.slice(source.indexOf('  const appCard ='), source.indexOf('  const appsHtml'));
assert.doesNotMatch(card, /app-sessions|data-new-in/);
assert.doesNotMatch(source, /session-fork|data-fork|forkSheet|Fork onto another model/);
assert.match(source, /id="session-edit"/);
assert.match(source, /id="session-delete"/);
console.log('PASS app chat selection, empty app creation, scoped tabs and new-session app selection');

state.sessions = [
  { appId: 'a', name: 'Tab 1' },
  { appId: 'a', name: 'Tab 3' },
  { appId: 'b', name: 'Tab 20' },
];
assert.equal(context.nextTabName('a'), 'Tab 4', 'deleted tabs do not cause duplicate names');
assert.equal(context.nextTabName('empty'), 'Tab 1', 'each app starts its own numbering');
state.sessions = [{ appId: 'a', name: 'Custom' }, { appId: 'a', name: 'Another' }];
assert.equal(context.nextTabName('a'), 'Tab 3', 'custom names still count as tabs');
state.sessions.push({ name: 'Tab 1' });
assert.equal(context.nextTabName(null), 'Tab 2');
assert.match(source, /name: \$\('n-name'\)\.value\.trim\(\) \|\| nextTabName\(\$\('n-app'\)\.value\)/);
const server = await fs.readFile('server/index.js', 'utf8');
assert.match(server, /name: 'Tab 1', model: cfg.default, projectDir: app.dir, appId: app.id/);
