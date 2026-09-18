// Machine placement: each host clones the projects placed on it, keeps them
// up to date, and removes its copy only once nothing in it is unsaved.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appPlacement, validHosts, hostsFor, unsafeToRemove } from '../src/core/cluster/placement.js';
import { portableWorkspaces } from '../src/core/cluster/workspaces.js';
import { Replica } from '../src/core/cluster/raft.js';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'placement-')));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();

try {
  const remote = path.join(root, 'remote.git');
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(source, 'init', '-b', 'main');
  await fs.writeFile(path.join(source, 'hello.txt'), 'one');
  git(source, 'add', '.'); git(source, 'commit', '-m', 'one');
  git(source, 'remote', 'add', 'origin', remote); git(source, 'push', '-u', 'origin', 'main');

  const values = {};
  const members = [{ id: 'A', name: 'laptop' }, { id: 'B', name: 'desktop' }];
  const cluster = {
    self: members[0], shared: () => true,
    command: async (c) => { values[c.id] = c.value; },
    replica: { members: () => members, state: { values, history: { A: members[0], B: members[1] }, sessions: {} } },
  };
  const app = { id: 'proj-abc123', name: 'Proj', dir: path.join(root, 'elsewhere', 'proj'), repo: remote, ownerNode: 'B', hosts: ['A', 'B'] };
  const apps = [app];
  const base = path.join(root, 'Projects');
  let busy = false;
  const placement = appPlacement(cluster, path.join(root, 'data'), { loadApps: async () => apps, base, running: () => busy });

  assert.deepEqual(hostsFor({ ownerNode: 'B' }, 'A'), ['B']);
  assert.deepEqual(hostsFor({ hosts: ['A', 'B'] }, 'A'), ['A', 'B']);
  assert.deepEqual(validHosts(['A', 'A', 'B'], members), ['A', 'B']);
  assert.throws(() => validHosts([], members), /at least one/);
  assert.throws(() => validHosts(['Z'], members), /not part of this system/);

  // Placed here: cloned from the remote, and reported to the cluster.
  let report = await placement.reconcile();
  const copy = path.join(base, 'proj');
  assert.equal(report[app.id].state, 'ready');
  assert.equal(await fs.readFile(path.join(copy, 'hello.txt'), 'utf8'), 'one');
  assert.equal(await placement.localDir(app), copy);
  assert.equal(values['placement:A'][app.id].dir, copy);
  assert.equal(placement.describe(app).find((m) => m.id === 'A').state, 'ready');
  console.log('PASS a project placed on this machine is cloned from its Git remote');

  // Work pushed from another machine arrives.
  await fs.writeFile(path.join(source, 'hello.txt'), 'two');
  git(source, 'commit', '-am', 'two'); git(source, 'push');
  await placement.reconcile();
  assert.equal(await fs.readFile(path.join(copy, 'hello.txt'), 'utf8'), 'two');
  console.log('PASS a clean copy fast-forwards to what was pushed');

  // Taken off this machine: unsaved work keeps the copy, with the reason shown.
  app.hosts = ['B'];
  await fs.writeFile(path.join(copy, 'hello.txt'), 'unsaved');
  busy = true;
  report = await placement.reconcile();
  assert.equal(report[app.id].state, 'removing');
  busy = false;
  report = await placement.reconcile();
  assert.equal(report[app.id].state, 'kept');
  assert.match(report[app.id].error, /uncommitted changes/);
  git(copy, 'commit', '-am', 'local only');
  assert.match(await unsafeToRemove(copy), /not pushed/);
  git(copy, 'push');
  report = await placement.reconcile();
  assert.equal(report[app.id], undefined);
  await assert.rejects(fs.stat(copy));
  assert.equal(await placement.localDir(app), null);
  console.log('PASS removing a machine deletes its copy only once everything is pushed');

  // Without a remote there is nothing to clone from yet.
  apps.push({ id: 'fresh-def456', name: 'Fresh', dir: path.join(root, 'elsewhere', 'fresh'), repo: null, ownerNode: 'B', hosts: ['A', 'B'] });
  report = await placement.reconcile();
  assert.equal(report['fresh-def456'].state, 'waiting');
  // A new project owned here gets its folder made here.
  apps[1].ownerNode = 'A';
  report = await placement.reconcile();
  assert.equal(report['fresh-def456'].state, 'ready');
  assert.ok((await fs.stat(path.join(base, 'fresh'))).isDirectory());
  // Deleting the app record leaves its folder alone.
  apps.pop();
  await placement.reconcile();
  assert.ok((await fs.stat(path.join(base, 'fresh'))).isDirectory());
  console.log('PASS projects without a remote wait, new ones get a folder, deleted ones keep their files');

  // A folder already holding something else is never cloned over.
  app.hosts = ['A'];
  await fs.mkdir(copy); await fs.writeFile(path.join(copy, 'mine.txt'), 'x');
  await fs.mkdir(path.join(base, 'proj-abc123')); await fs.writeFile(path.join(base, 'proj-abc123', 'mine.txt'), 'x');
  report = await placement.reconcile();
  assert.equal(report[app.id].state, 'error');
  assert.match(report[app.id].error, /already holds something else/);
  assert.equal(await fs.readFile(path.join(copy, 'mine.txt'), 'utf8'), 'x');
  console.log('PASS an unrelated folder at the destination is left untouched');

  // Loose sessions are no longer copied through the cluster log.
  await assert.rejects(portableWorkspaces(cluster).prepare({ projectDir: '/x', ownerNode: 'B' }), /on desktop and is not copied/);
  const replica = new Replica(path.join(root, 'r'), { self: { id: 'A', name: 'a' }, send: async () => ({}) });
  await replica.init();
  await replica.propose({ type: 'value', id: 'workspace:old', value: { files: {} } });
  await replica.propose({ type: 'value', id: 'workspace:old', value: null });
  assert.equal('workspace:old' in replica.state.values, false);
  replica.stop();
  console.log('PASS old file checkpoints can be dropped from the cluster log');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
