/** Portable project checkpoints. Never overwrite another host's original tree.
 * Dependencies/build output and symlinks are omitted; interrupted jobs are not
 * resumed. A checkpoint records exactly which working files were captured.
 */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { HARNESS_ROOT, HARNESS_APP_ID, refuseAsProjectDir } from '../harness-guard.js';
const ignored = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.DS_Store', 'dist', 'build']);
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
export function portableWorkspaces(cluster, { base = path.join(os.homedir(), 'Projects', 'OrchestratorWorkspaces') } = {}) {
  let pending = Promise.resolve();
  async function capture(session) {
    if (!session.projectDir || path.resolve(session.projectDir) === HARNESS_ROOT || session.appId === HARNESS_APP_ID || session.editsHarness) return;
    const refusal = refuseAsProjectDir(session.projectDir);
    if (refusal) throw new Error(refusal);
    const key = session.workspaceId ||= digest(`${session.ownerNode || cluster.self.id}:${session.projectDir}`).slice(0, 24);
    const files = {}; let bytes = 0;
    async function walk(dir, relative = '') {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const item of entries) {
        if (ignored.has(item.name) || item.name.endsWith('.log') || item.name === '.orchestrator-node.env' || item.name === '.env' || item.name.startsWith('.env.')) continue;
        const name = relative ? `${relative}/${item.name}` : item.name;
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) { await walk(path.join(dir, item.name), name); continue; }
        if (!item.isFile()) continue;
        const handle = await fs.open(path.join(dir, item.name), constants.O_RDONLY | constants.O_NOFOLLOW);
        let data, mode;
        try {
          const stat = await handle.stat();
          if (stat.size > 16_000_000 || bytes + stat.size > 48_000_000) throw new Error('Project checkpoint exceeds 48 MB (16 MB per file). Keep large datasets outside the replicated workspace.');
          data = await handle.readFile(); mode = stat.mode & 0o777;
        } finally { await handle.close(); }
        bytes += data.length;
        files[name] = { data: data.toString('base64'), hash: digest(data), mode };
      }
    }
    await walk(session.projectDir);
    const value = { files, capturedAt: Date.now(), source: cluster.self.id };
    const old = cluster.replica.state.values[`workspace:${key}`];
    if (JSON.stringify(Object.fromEntries(Object.entries(old?.files || {}).map(([n, f]) => [n, f.hash]))) !==
        JSON.stringify(Object.fromEntries(Object.entries(files).map(([n, f]) => [n, f.hash])))) {
      await cluster.replica.propose({ type: 'value', id: `workspace:${key}`, value });
    }
    session.workspaceCheckpoint = value.capturedAt;
    delete session.workspaceError;
  }
  return {
    capture(session) {
      const task = pending.catch(() => {}).then(() => capture(session)); pending = task; return task;
    },
    async prepare(session) {
      if (session.appId === HARNESS_APP_ID || session.editsHarness || (session.monitorFor && (session.projectDir === HARNESS_ROOT || cluster.replica.state.sessions[session.monitorFor]?.appId === HARNESS_APP_ID))) { session.projectDir = HARNESS_ROOT; session.ownerNode = cluster.self.id; return; }
      if (!session.ownerNode || session.ownerNode === cluster.self.id) return;
      const snapshot = cluster.replica.state.values[`workspace:${session.workspaceId}`];
      if (!snapshot) throw new Error('This project has no replicated file checkpoint yet. Its transcript is available; reconnect the original host to synchronize its files.');
      if (!/^[a-f0-9]{24}$/.test(session.workspaceId)) throw new Error('Invalid workspace identity');
      // A fresh generation avoids destroying local files or following symlinks
      // left by a previous process. Keep old generations for manual recovery.
      const dir = path.join(base, session.workspaceId, crypto.randomUUID());
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      for (const [name, file] of Object.entries(snapshot.files)) {
        if (path.isAbsolute(name) || name.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid checkpoint path');
        const data = Buffer.from(file.data, 'base64');
        if (digest(data) !== file.hash) throw new Error('Checkpoint checksum mismatch');
        const target = path.join(dir, name); await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, data, { flag: 'wx', mode: Number.isInteger(file.mode) ? file.mode & 0o777 : 0o600 });
      }
      session.projectDir = dir; session.ownerNode = cluster.self.id;
    },
  };
}
