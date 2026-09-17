import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../server/public/app.js', import.meta.url), 'utf8');
assert.doesNotMatch(source, /project-machines/);
assert.match(source, /id="h-machines"/);
assert.match(source, /\$\('h-machines'\)\.onclick = machinesSheet/);
const start = source.indexOf('  const appCard = (a) => {');
const end = source.indexOf('\n  const appsHtml', start);
const card = vm.runInNewContext(source.slice(start, end) + '\nappCard;', {
  sessionsFor: () => [], expandedApps: new Set(), esc: String, shortDir: String,
});
const base = { id: 'project', name: 'Project', dir: '/project', urls: {} };
for (const command of ['', '   ', undefined]) {
  const html = card({ ...base, start: command });
  assert.match(html, />chat</);
  assert.ok(!html.includes('data-app-run'));
  assert.ok(html.includes('data-app-edit'));
  assert.ok(html.includes('data-app-toggle'));
}
assert.match(card({ ...base, start: 'npm start' }), /title="Start">▶/);
assert.match(card({ ...base, running: true }), /title="Stop">■/);
assert.match(card({ ...base, builtin: true }), /data-harness-restart/);
assert.ok(!card({ ...base, builtin: true }).includes('>chat<'));
console.log('PASS workspace cards, launchable apps, running processes, and Harness controls');

const order = vm.runInNewContext(source.slice(source.indexOf('function orderProjects('),
  source.indexOf('function renderAppsSheet(')) + '\norderProjects;');
const projects = [
  { id: 'workspace', start: '  ' },
  { id: 'stopped-app', start: 'npm start' },
  { id: 'self', builtin: true },
  { id: 'running-app', running: true },
  { id: 'other-workspace' },
];
const original = JSON.stringify(projects);
assert.equal(JSON.stringify(order(projects).map((a) => a.id)),
  JSON.stringify(['self', 'stopped-app', 'running-app', 'workspace', 'other-workspace']));
assert.equal(JSON.stringify(projects), original, 'ordering does not mutate the cached list');
console.log('PASS project ordering keeps the built-in first, apps next, workspaces last');

const group = vm.runInNewContext(source.slice(source.indexOf('function orderProjects('),
  source.indexOf('let peerCatalog')) + '\nprojectGroups;');
const grouped = group([
  { id: 'chat' }, { id: 'stopped', start: 'npm start' },
  { id: 'running', running: true }, { id: 'self', builtin: true },
  { id: 'former', lastStartedAt: 123 }, { id: 'blank', start: '  ' },
]);
assert.equal(grouped.visible.map((a) => a.id).join(','), 'self,running');
assert.equal(grouped.stopped.map((a) => a.id).join(','), 'stopped,former');
assert.equal(grouped.chats.map((a) => a.id).join(','), 'chat,blank');
console.log('PASS running apps stay visible; stopped and previously launched apps separate from Chats');

const renderGroups = source.slice(source.indexOf('  const appsHtml = (() =>'),
  source.indexOf('  openSheet(`<h2>Apps &amp; Chats</h2>')) + '\nappsHtml;';
const now = 1_800_000_000_000;
const context = {
  Date: { now: () => now },
  d: { apps: [{ id: 'self', builtin: true }, { id: 'stopped', start: 'npm start' }, { id: 'chat' }] },
  projectGroups: group, openProjectGroups: new Set(),
  state: { sessions: [{ id: 'working', updatedAt: now }, { id: 'idle', updatedAt: now }], busy: ['working'] },
  loose: [{ id: 'working' }, { id: 'idle' }],
  sessionRow: (s) => `<session>${s.id}</session>`, appCard: (a) => `<app>${a.id}</app>`,
};
const html = vm.runInNewContext(renderGroups, context);
assert.ok(html.indexOf('<session>working') < html.indexOf('<app>self'));
assert.ok(html.indexOf('data-project-group="recent"') < html.indexOf('<app>self'));
assert.equal((html.match(/<session>working/g) ?? []).length, 1);
assert.equal((html.match(/<details/g) ?? []).length, 3);
assert.match(html, /Recent sessions · 1 active/);
assert.doesNotMatch(html, /<h3>Active sessions/);
assert.ok(!/<details[^>]*\sopen[ >]/.test(html));
assert.match(html, /Chats \(2\)/);
context.openProjectGroups.add('chats');
assert.match(vm.runInNewContext(renderGroups, { ...context }), /data-project-group="chats" open/);
context.openProjectGroups.add('recent');
assert.match(vm.runInNewContext(renderGroups, { ...context }), /data-project-group="recent" open/);
const resetRecent = source.slice(source.indexOf('async function appsSheet() {') + 'async function appsSheet() {'.length,
  source.indexOf('  // Draw first, fetch second.'));
vm.runInNewContext(resetRecent, { sheetView: 'apps', openProjectGroups: context.openProjectGroups });
assert.ok(context.openProjectGroups.has('recent'), 'refresh preserves an explicitly opened dropdown');
vm.runInNewContext(resetRecent, { sheetView: null, openProjectGroups: context.openProjectGroups });
assert.ok(!context.openProjectGroups.has('recent'), 'reopening starts collapsed');
const manySessions = Array.from({ length: 15 }, (_, i) => ({ id: `idle-${i}`, updatedAt: now - 15 + i }));
const recentHtml = vm.runInNewContext(renderGroups, { ...context,
  state: { sessions: [{ id: 'working', updatedAt: now }, ...manySessions], busy: ['working'] }, loose: [] });
assert.match(recentHtml, /Recent sessions · 1 active \(11\)/);
assert.ok(recentHtml.indexOf('<session>working') < recentHtml.indexOf('<session>idle-14'));
assert.ok(recentHtml.indexOf('<session>idle-14') < recentHtml.indexOf('<session>idle-13'));
assert.doesNotMatch(recentHtml, /<session>idle-4</);
assert.doesNotMatch(vm.runInNewContext(renderGroups, { ...context, state: { sessions: [], busy: [] }, loose: [] }),
  /data-project-group="recent"/);
console.log('PASS recent sessions collapse on reopen, retain expansion during refresh, and list active then recent sessions');
const cutoff = now - 24 * 60 * 60 * 1000;
const agedSessions = [
  { id: 'boundary', updatedAt: cutoff },
  { id: 'expired', updatedAt: cutoff - 1 },
  { id: 'created-recently', createdAt: now },
  { id: 'revived', createdAt: cutoff - 1000, updatedAt: now },
  { id: 'expired-active', updatedAt: cutoff - 1 },
  { id: 'undated' },
];
const agedHtml = vm.runInNewContext(renderGroups, { ...context,
  state: { sessions: agedSessions, busy: ['expired-active'] }, loose: [] });
for (const id of ['boundary', 'created-recently', 'revived']) assert.ok(agedHtml.includes(`<session>${id}</session>`));
for (const id of ['expired', 'expired-active', 'undated']) assert.ok(!agedHtml.includes(`<session>${id}</session>`));
assert.doesNotMatch(vm.runInNewContext(renderGroups, { ...context,
  state: { sessions: [{ id: 'old', updatedAt: cutoff - 1 }], busy: [] }, loose: [] }), /data-project-group="recent"/);
console.log('PASS Recent sessions excludes activity older than 24 hours and uses creation time when needed');
const remembered = { id: 'simulation', hasBeenApp: true, start: '', running: false };
assert.equal(group([remembered]).stopped[0].id, 'simulation');
assert.ok(!card({ ...base, ...remembered }).includes('>chat<'));
console.log('PASS previously detected apps remain stopped apps without a start command');

const row = vm.runInNewContext(source.slice(source.indexOf('  const sessionRow ='),
  source.indexOf('  const appCard =')) + '\nsessionRow;', {
  d: { apps: [{ id: 'one', name: 'First app' }, { id: 'two', name: 'Second app' }] },
  state: {}, esc: (s) => String(s).replaceAll('<', '&lt;'), sessionStatus: () => '',
});
assert.match(row({ id: 's1', appId: 'one', name: 'Tab 1' }), /First app · Tab 1/);
assert.match(row({ id: 's2', appId: 'two', name: 'Tab 1' }), /Second app · Tab 1/);
assert.match(row({ id: 's3', appId: 'one', name: '<custom>' }), /First app · &lt;custom>/);
assert.match(row({ id: 's4', name: 'Standalone' }), /class="t">Standalone /);
assert.match(row({ id: 's5', appId: 'missing', name: 'Orphan' }), />Orphan /);
console.log('PASS session rows distinguish apps with App · Tab labels and preserve standalone names');
