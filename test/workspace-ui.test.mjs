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
  assert.match(html, />workspace</);
  assert.ok(!html.includes('data-app-run'));
  assert.ok(html.includes('data-app-edit'));
  assert.ok(html.includes('data-app-toggle'));
}
assert.match(card({ ...base, start: 'npm start' }), /title="Start">▶/);
assert.match(card({ ...base, running: true }), /title="Stop">■/);
assert.match(card({ ...base, builtin: true }), /data-harness-restart/);
assert.ok(!card({ ...base, builtin: true }).includes('>workspace<'));
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
