import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile('server/public/app.js', 'utf8');
const nodes = new Map();
const $ = (id) => {
  if (!nodes.has(id)) nodes.set(id, { querySelectorAll: () => [] });
  return nodes.get(id);
};
const calls = [], opened = [], sheets = [];
const state = { sessions: [{ id: 'one', appId: 'a', name: 'One' }, { id: 'two', appId: 'a', name: 'Two' }, { id: 'other', appId: 'b', name: 'Other' }], default: 'model' };
const context = { state, $, esc: String, sessionStorageKey: 'host', localStorage: { getItem: () => 'two' },
  openSession: async id => opened.push(id), api: async (url, opts) => { calls.push(JSON.parse(opts.body)); return { id: 'new', appId: 'empty' }; },
  showBanner: assert.fail, sessionOptionsSheet() {}, newSheet() { sheets.push({ ...context.draft }); }, draft: {},
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function nextTabName('), source.indexOf('function sessionOptionsSheet(')), context);
await context.openProject({ id: 'a' });
assert.equal(opened.at(-1), 'two');
state.session = state.sessions[0];
await context.openProject({ id: 'a' });
assert.equal(opened.at(-1), 'one');
await context.openProject({ id: 'empty', name: 'Empty' });
assert.deepEqual(sheets.at(-1), { appId: 'empty' });
assert.equal(calls.length, 0, 'opening an empty app never creates a default session');
assert.equal(opened.at(-1), 'one', 'opening the form does not open a new session');
context.draft = { appId: 'other', ownerNode: 'pc', model: 'old-model' };
await context.openProject({ id: 'empty', name: 'Empty' });
assert.deepEqual(sheets.at(-1), { appId: 'empty' }, 'a fresh form does not inherit another draft’s computer or model');
assert.equal(calls.length, 0);
assert.equal(state.sessions.length, 3, 'canceling and reopening leaves the session list unchanged');
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
console.log('PASS app chat selection, empty app session form, scoped tabs and new-session app selection');

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

state.apps = [{ id: 'a', executionHosts: ['mac', 'pc'] }];
state.machines = { leader: 'mac', hosts: [{ id: 'mac', number: 1, name: 'Mac' }, { id: 'pc', number: 2, name: 'PC' }] };
state.sessions = [{ id: 'remote', appId: 'a', name: 'Remote', ownerNode: 'pc' }];
state.session = state.sessions[0];
context.paintSessionTabs();
assert.match($('session-tabs').innerHTML, /Computer 2: PC/);
assert.match($('session-tabs').innerHTML, /<text x="14" y="13">2<\/text>/);
state.apps[0].executionHosts = ['pc'];
context.paintSessionTabs();
assert.doesNotMatch($('session-tabs').innerHTML, /tab-computer/);

state.machines.hosts[0].active = true;
state.machines.hosts[1].active = false;
state.sessions = [
  { id: 'offline', appId: 'a', name: 'Offline', ownerNode: 'pc', createdAt: 1 },
  { id: 'online', appId: 'a', name: 'Online', ownerNode: 'mac', createdAt: 2 },
];
state.session = state.sessions[0];
context.paintSessionTabs();
assert.deepEqual(tabIds(), ['online', 'offline']);
assert.match($('session-tabs').innerHTML, /class="ghost on offline" disabled aria-label="Offline · computer offline"/);
assert.equal(context.projectSession({ id: 'a' }).id, 'online');
state.machines.hosts[1].active = true;
context.paintSessionTabs();
assert.deepEqual(tabIds(), ['offline', 'online']);
assert.doesNotMatch($('session-tabs').innerHTML, /disabled/);

let finishSheet;
context.newSheet = async () => {
  sheets.push({ ...context.draft });
  await new Promise(resolve => { finishSheet = resolve; });
};
const before = sheets.length;
const first = context.openProject({ id: 'double-click' });
await context.openProject({ id: 'double-click' });
assert.equal(sheets.length, before + 1);
finishSheet();
await first;
assert.equal(calls.length, 0, 'double-clicking an empty app only opens the form');

// Exercise the create button itself while its request is still pending.
let finishCreation;
context.api = async () => {
  calls.push('concurrent');
  await new Promise(resolve => { finishCreation = resolve; });
  return { id: 'single', appId: 'a' };
};
for (const [id, value] of Object.entries({ 'n-dir': '/project', 'n-app': 'a', 'n-computer': 'mac',
  'n-name': '', 'n-model': 'model', 'n-mode': 'agent', 'n-sys': '' })) $(id).value = value;
state.home = '/home';
const handlerStart = source.indexOf('  let submitting = false;');
const handlerEnd = source.indexOf('\n}\n\nasync function browseSheet', handlerStart);
vm.runInContext(source.slice(handlerStart, handlerEnd), context);
const create = $('n-go').onclick;
const beforeButton = calls.length;
const pending = create();
await create();
assert.equal(calls.length, beforeButton + 1);
assert.equal($('n-go').disabled, true);
finishCreation();
await pending;
await create();
assert.equal(calls.length, beforeButton + 1, 'a late second click after success cannot create again');
console.log('PASS offline tab ordering, disabled state, reconnect and concurrent creation guards');

const errors = [];
const retryContext = vm.createContext({ $, state, draft: {}, nextTabName: () => 'Tab 5',
  showBanner: message => errors.push(message), openSession: async () => {},
  api: async () => { throw new Error('Computer unavailable'); },
});
$('n-go').disabled = false;
vm.runInContext(source.slice(handlerStart, handlerEnd), retryContext);
await $('n-go').onclick();
assert.equal($('n-go').disabled, false, 'failed creation unlocks the button');
assert.deepEqual(errors, ['Computer unavailable']);
retryContext.api = async () => ({ id: 'retry', appId: 'a' });
await $('n-go').onclick();
assert.equal(state.sessions[0].id, 'retry', 'creation can be retried after a failure');
