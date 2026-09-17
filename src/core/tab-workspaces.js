/** Per-tab working trees and serialized, tested integration into the project. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { commitAndPush, createPrivateRepo } from './git.js';

const exec = promisify(execFile);
const identity = ['-c', 'user.name=Harness', '-c', 'user.email=harness@localhost'];
async function git(dir, ...args) {
  const { stdout } = await exec('git', [...identity, ...args], { cwd: dir, timeout: 120_000, maxBuffer: 8e6 });
  return stdout.trim();
}
async function clean(dir) { return !(await git(dir, 'status', '--porcelain')); }
async function repository(dir) {
  const root = await git(dir, 'rev-parse', '--show-toplevel');
  const common = await git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  return { root: await fs.realpath(root), common };
}
const queues = new Map();
// The file lock also excludes another harness process on the same host. Never
// steal a lock on timeout: leave recovery of an interrupted integration explicit.
async function locked(repo, action) {
  const previous = queues.get(repo.common) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const lock = path.join(repo.common, 'harness-integration.lock');
    try { await fs.mkdir(lock); }
    catch (e) { if (e.code === 'EEXIST') throw new Error('Another harness process holds the project integration lock. Retry after it finishes; an interrupted lock requires recovery.'); throw e; }
    try { return await action(); } finally { await fs.rmdir(lock); }
  });
  queues.set(repo.common, task);
  try { return await task; } finally { if (queues.get(repo.common) === task) queues.delete(repo.common); }
}

export async function prepareTab(session) {
  let repo;
  try { repo = await repository(session.projectDir); }
  catch {
    await git(session.projectDir, 'init', '-b', 'main');
    repo = await repository(session.projectDir);
  }
  return locked(repo, async () => {
    const branch = await git(repo.root, 'symbolic-ref', '--short', 'HEAD');
    let head;
    try { head = await git(repo.root, 'rev-parse', 'HEAD'); }
    catch {
      await git(repo.root, 'add', '-A');
      await git(repo.root, 'commit', '--allow-empty', '-m', 'harness: initial project snapshot');
      head = await git(repo.root, 'rev-parse', 'HEAD');
    }
    if (!await clean(repo.root)) throw new Error('The shared project has uncommitted changes. Commit or move those changes before starting an isolated tab; they will not be included automatically.');
    const key = crypto.createHash('sha256').update(session.id).digest('hex').slice(0, 24);
    const dir = path.join(repo.common, 'harness-tabs', key);
    const tabBranch = `harness/tab-${key}`;
    await fs.mkdir(path.dirname(dir), { recursive: true });
    try { await fs.stat(dir); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const exists = await git(repo.root, 'branch', '--list', tabBranch);
      await git(repo.root, 'worktree', 'add', ...(exists ? [] : ['-b', tabBranch]), dir, exists ? tabBranch : head);
    }
    if (await git(dir, 'symbolic-ref', '--short', 'HEAD') !== tabBranch) throw new Error('Tab worktree is on an unexpected branch; restore its tab branch before continuing.');
    // Only synchronize clean trees. Pending edits and failed integrations remain
    // available to the same tab, including after a server restart.
    if (await clean(dir)) {
      try { await git(dir, 'merge', '--no-edit', head); }
      catch { await git(dir, 'merge', '--abort').catch(() => {}); }
    }
    session.tabWorkspace = { root: repo.root, common: repo.common, dir, branch: tabBranch, target: branch };
    return session.tabWorkspace;
  });
}

async function validate(dir, log, base, signal) {
  await git(dir, 'diff', '--check', base, 'HEAD');
  let pkg;
  try { pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let custom;
  try { custom = JSON.parse(await fs.readFile(path.join(dir, '.harness-integration.json'), 'utf8')).command; }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (custom !== undefined && (typeof custom !== 'string' || !custom.trim())) throw new Error('.harness-integration.json needs a nonempty command string.');
  if (!custom && !pkg?.scripts?.test) throw new Error('No automated integration check configured. Add a package.json test script or .harness-integration.json with a command; the tab commit has been kept without changing the project.');
  const output = await fs.open(log, 'w');
  const run = async (command, args) => new Promise((resolve, reject) => {
    execFile(command, args,
      { cwd: dir, timeout: 600_000, maxBuffer: 16e6, signal }, async (error, stdout, stderr) => {
        try { await output.writeFile(stdout + stderr); error ? reject(new Error(`Integration check failed (${args.join(' ')}). See ${log}`)) : resolve(); }
        catch (e) { reject(e); }
      });
  });
  try {
    if (custom) {
      await run(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/d', '/s', '/c', custom] : ['-c', custom]);
    } else {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.devDependencies ?? {}).length) await run(npm, ['ci', '--no-audit', '--no-fund']);
      await run(npm, ['test']);
    }
  } finally { await output.close(); }
  if (!await clean(dir)) throw new Error('Integration checks changed tracked or unignored files; review the tab before integrating.');
}

export async function integrateTab(session, options = {}) {
  const ws = session.tabWorkspace;
  if (!ws) throw new Error('This session has no isolated worktree. Start a coding turn before integrating.');
  const repo = await repository(session.projectDir);
  if (repo.root !== ws.root || repo.common !== ws.common) throw new Error('The project moved; reopen the tab before integrating.');
  return locked(repo, async () => {
    if (await git(ws.dir, 'symbolic-ref', '--short', 'HEAD') !== ws.branch) throw new Error('Tab branch changed; integration stopped.');
    options.signal?.throwIfAborted();
    const saved = await commitAndPush(ws.dir, { push: false });
    if (!saved.ok) return saved;
    const head = await git(repo.root, 'rev-parse', 'HEAD');
    if (await git(repo.root, 'symbolic-ref', '--short', 'HEAD') !== ws.target || !await clean(repo.root)) {
      throw new Error('Shared project changed or has uncommitted edits. Tab work is saved; integration postponed.');
    }
    const tabHead = await git(ws.dir, 'rev-parse', 'HEAD');
    const ahead = await git(ws.dir, 'rev-list', '--count', `${head}..${tabHead}`);
    if (ahead === '0') return { ok: true, skipped: 'no changes' };
    try { await git(ws.dir, 'merge', '--no-edit', head); }
    catch {
      await git(ws.dir, 'merge', '--abort').catch(() => {});
      throw new Error(`Merge conflict. Work is saved on ${ws.branch}. In this tab, merge ${head}, resolve the conflicts, and retry. The shared project was not changed.`);
    }
    const candidate = await git(ws.dir, 'rev-parse', 'HEAD');
    const log = path.join(repo.common, 'harness-tabs', `${path.basename(ws.dir)}-checks.log`);
    session.integrationLog = log;
    await validate(ws.dir, log, head, options.signal);
    options.signal?.throwIfAborted();
    if (await git(ws.dir, 'rev-parse', 'HEAD') !== candidate || !await clean(ws.dir)) throw new Error('Tab changed during checks; retry integration.');
    if (await git(repo.root, 'rev-parse', 'HEAD') !== head || !await clean(repo.root)
      || await git(repo.root, 'symbolic-ref', '--short', 'HEAD') !== ws.target) throw new Error('Shared project changed during checks; retry integration.');
    const files = (await git(ws.dir, 'diff', '--name-only', head, candidate)).split('\n').filter(Boolean);
    await git(repo.root, 'merge', '--ff-only', candidate);
    // Publish the integrated target, never the private tab branch. A push failure
    // leaves the validated commit in the local project for a later retry.
    let pushed = false, created, reason = 'push disabled';
    if (options.push) {
      try {
        const remotes = await git(repo.root, 'remote');
        if (!remotes.split('\n').includes('origin') && options.autoCreatePrivate) {
          const result = await createPrivateRepo(repo.root, ws.target, options.appName);
          pushed = result.ok; created = result.repo; reason = result.reason;
        } else { await git(repo.root, 'push', '-u', 'origin', ws.target); pushed = true; reason = null; }
      }
      catch (e) { reason = e.stderr || e.message; }
    }
    return { ok: true, committed: true, integrated: true, sha: candidate.slice(0, 8), files, pushed, reason, created };
  });
}
