import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../server/public/app.js', import.meta.url), 'utf8');
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
const context = {
  d: { apps: [{ id: 'self', builtin: true }, { id: 'stopped', start: 'npm start' }, { id: 'chat' }] },
  projectGroups: group, openProjectGroups: new Set(),
  state: { sessions: [{ id: 'working' }, { id: 'idle' }], busy: ['working'] },
  loose: [{ id: 'working' }, { id: 'idle' }],
  sessionRow: (s) => `<session>${s.id}</session>`, appCard: (a) => `<app>${a.id}</app>`,
};
const html = vm.runInNewContext(renderGroups, context);
assert.ok(html.indexOf('<session>working') < html.indexOf('<app>self'));
assert.ok(html.indexOf('<app>self') < html.indexOf('<details'));
assert.equal((html.match(/<session>working/g) ?? []).length, 1);
assert.equal((html.match(/<details/g) ?? []).length, 2);
assert.ok(!/<details[^>]*\sopen[ >]/.test(html));
assert.match(html, /Chats \(2\)/);
context.openProjectGroups.add('chats');
assert.match(vm.runInNewContext(renderGroups, { ...context }), /data-project-group="chats" open/);
console.log('PASS active sessions first, persistent orchestrator, default-collapsed groups and retained expansion');
