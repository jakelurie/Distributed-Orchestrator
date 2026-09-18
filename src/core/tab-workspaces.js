/** Per-tab working trees and serialized, tested integration into the project. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { commitAndPush, createPrivateRepo, githubCommitUrl } from './git.js';

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
  return { root: await fs.realpath(root), common: await fs.realpath(common) };
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

export async function prepareTab(session, { distributed = false } = {}) {
  let repo;
  try { repo = await repository(session.projectDir); }
  catch {
    await git(session.projectDir, 'init', '-b', 'main');
    repo = await repository(session.projectDir);
  }
  return locked(repo, async () => {
    const branch = await git(repo.root, 'symbolic-ref', '--short', 'HEAD');
    if (distributed) {
      if (!await clean(repo.root)) throw new Error('Commit the project’s local changes before syncing across computers.');
      await git(repo.root, 'fetch', 'origin', `refs/heads/${branch}`);
      await git(repo.root, 'merge', '--ff-only', 'FETCH_HEAD');
    }
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
    const relative = path.relative(repo.root, await fs.realpath(session.projectDir));
    session.tabWorkspace = { root: repo.root, common: repo.common, dir, cwd: path.join(dir, relative), branch: tabBranch, target: branch };
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
    signal?.throwIfAborted();
    const child = spawn(command, args, { cwd: dir, detached: process.platform !== 'win32',
      stdio: ['ignore', output.fd, output.fd], windowsHide: true });
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (!child.pid) return;
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
    };
    const timer = setTimeout(stop, 600_000);
    signal?.addEventListener('abort', stop, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    child.once('error', (e) => { cleanup(); reject(e); });
    child.once('close', (code) => {
      cleanup();
      if (code === 0 && !stopped) resolve();
      else reject(new Error(`Integration check ${stopped ? 'cancelled or timed out' : 'failed'} (${args.join(' ')}). See ${log}`));
    });
    if (signal?.aborted) stop();
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

async function commitLink(repo, sha, pushed) {
  if (!pushed) return null;
  const remote = await git(repo.root, 'remote', 'get-url', 'origin').catch(() => '');
  return githubCommitUrl(remote, sha);
}

async function publish(repo, target, options) {
  let pushed = false, created, reason = 'push disabled';
  if (options.push) {
    try {
      const remotes = await git(repo.root, 'remote');
      if (!remotes.split('\n').includes('origin') && options.autoCreatePrivate) {
        const result = await createPrivateRepo(repo.root, target, options.appName);
        pushed = result.ok; created = result.repo; reason = result.reason;
      } else { await git(repo.root, 'push', '-u', 'origin', target); pushed = true; reason = null; }
    }
    catch (e) { reason = e.stderr || e.message; }
  }
  return { pushed, reason, created };
}

// Git's remote branch update is the cross-machine serialization point. A
// rejected push never updates the local target. Fetch, merge and test the new
// candidate again; never force-push or reuse checks against an older base.
async function integrateDistributed(repo, session, options) {
  const ws = session.tabWorkspace;
  const saved = await commitAndPush(ws.dir, { push: false });
  if (!saved.ok) return saved;
  for (let attempt = 0; attempt < 3; attempt++) {
    options.signal?.throwIfAborted();
    if (await git(repo.root, 'symbolic-ref', '--short', 'HEAD') !== ws.target || !await clean(repo.root))
      throw new Error('The project has local changes. Tab work is saved; integration is waiting.');
    const local = await git(repo.root, 'rev-parse', 'HEAD');
    await git(repo.root, 'fetch', 'origin', `refs/heads/${ws.target}`);
    const remote = await git(repo.root, 'rev-parse', 'FETCH_HEAD');
    try {
      await git(ws.dir, 'merge', '--no-edit', local);
      await git(ws.dir, 'merge', '--no-edit', remote);
    } catch {
      await git(ws.dir, 'merge', '--abort').catch(() => {});
      throw new Error(`Changes from another computer conflict with this tab. Work is saved on ${ws.branch}; resolve the merge in this tab and retry integration.`);
    }
    const candidate = await git(ws.dir, 'rev-parse', 'HEAD');
    const log = path.join(repo.common, 'harness-tabs', `${path.basename(ws.dir)}-checks.log`);
    session.integrationLog = log;
    await options.onCheck?.(log);
    await validate(ws.dir, log, remote, options.signal);
    options.signal?.throwIfAborted();
    if (await git(ws.dir, 'rev-parse', 'HEAD') !== candidate || !await clean(ws.dir)
      || await git(repo.root, 'rev-parse', 'HEAD') !== local || !await clean(repo.root))
      throw new Error('Files changed during integration checks; retry integration.');
    try { await git(ws.dir, 'push', 'origin', `${candidate}:refs/heads/${ws.target}`); }
    catch (e) {
      // Retry only a changed remote tip, never an uncertain unchanged failure.
      await git(repo.root, 'fetch', 'origin', `refs/heads/${ws.target}`);
      const latest = await git(repo.root, 'rev-parse', 'FETCH_HEAD');
      if (latest === candidate) { /* the push succeeded but its reply was lost */ }
      else if (latest !== remote) {
        await options.onWaiting?.('Another computer published first; merging and checking its changes.');
        continue;
      } else throw e;
    }
    await git(repo.root, 'merge', '--ff-only', candidate);
    const files = (await git(ws.dir, 'diff', '--name-only', local, candidate)).split('\n').filter(Boolean);
    return { ok: true, integrated: true, pushed: true, committed: true, sha: candidate.slice(0, 8), commitUrl: await commitLink(repo, candidate, true), files };
  }
  throw new Error('Other computers are still publishing changes. Tab work is saved; retry integration when they finish.');
}

export async function integrateTab(session, options = {}) {
  const ws = session.tabWorkspace;
  if (!ws) throw new Error('This session has no isolated worktree. Start a coding turn before integrating.');
  const repo = await repository(session.projectDir);
  if (repo.root !== ws.root || repo.common !== ws.common) throw new Error('The project moved; reopen the tab before integrating.');
  return locked(repo, async () => {
    if (await git(ws.dir, 'symbolic-ref', '--short', 'HEAD') !== ws.branch) throw new Error('Tab branch changed; integration stopped.');
    options.signal?.throwIfAborted();
    if (options.distributed) return integrateDistributed(repo, session, options);
    const saved = await commitAndPush(ws.dir, { push: false });
    if (!saved.ok) return saved;
    const head = await git(repo.root, 'rev-parse', 'HEAD');
    if (await git(repo.root, 'symbolic-ref', '--short', 'HEAD') !== ws.target || !await clean(repo.root)) {
      throw new Error('Shared project changed or has uncommitted edits. Tab work is saved; integration postponed.');
    }
    const tabHead = await git(ws.dir, 'rev-parse', 'HEAD');
    const ahead = await git(ws.dir, 'rev-list', '--count', `${head}..${tabHead}`);
    if (ahead === '0') {
      if (!options.retryPush) return { ok: true, skipped: 'no changes' };
      const publication = await publish(repo, ws.target, options);
      return { ok: true, integrated: true, sha: head.slice(0, 8), files: [], ...publication, commitUrl: await commitLink(repo, head, publication.pushed) };
    }
    try { await git(ws.dir, 'merge', '--no-edit', head); }
    catch {
      await git(ws.dir, 'merge', '--abort').catch(() => {});
      throw new Error(`Merge conflict. Work is saved on ${ws.branch}. In this tab, merge ${head}, resolve the conflicts, and retry. The shared project was not changed.`);
    }
    const candidate = await git(ws.dir, 'rev-parse', 'HEAD');
    const log = path.join(repo.common, 'harness-tabs', `${path.basename(ws.dir)}-checks.log`);
    session.integrationLog = log;
    await options.onCheck?.(log);
    await validate(ws.dir, log, head, options.signal);
    options.signal?.throwIfAborted();
    if (await git(ws.dir, 'rev-parse', 'HEAD') !== candidate || !await clean(ws.dir)) throw new Error('Tab changed during checks; retry integration.');
    if (await git(repo.root, 'rev-parse', 'HEAD') !== head || !await clean(repo.root)
      || await git(repo.root, 'symbolic-ref', '--short', 'HEAD') !== ws.target) throw new Error('Shared project changed during checks; retry integration.');
    const files = (await git(ws.dir, 'diff', '--name-only', head, candidate)).split('\n').filter(Boolean);
    await git(repo.root, 'merge', '--ff-only', candidate);
    // Publish the integrated target, never the private tab branch. A push failure
    // leaves the validated commit in the local project for a later retry.
    const publication = await publish(repo, ws.target, options);
    return { ok: true, committed: true, integrated: true, sha: candidate.slice(0, 8), files, ...publication, commitUrl: await commitLink(repo, candidate, publication.pushed) };
  });
}
