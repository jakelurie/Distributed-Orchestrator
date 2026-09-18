import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCluster } from '../src/core/cluster/index.js';
import { atomic } from '../src/core/cluster/raft.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cluster-startup-'));
let child, closed;
try {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const cluster = await createCluster(root);
  const peer = { id: 'unreachable-peer', name: 'Offline computer', url: 'http://127.0.0.1:1' };
  const disk = cluster.replica.disk;
  disk.initial = [cluster.self, peer];
  await atomic(cluster.replica.file, disk);

  // A paired host must serve HTTP while elections run, then take over alone.
  child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env,
    HARNESS_PORT: String(port), HARNESS_TOKEN: 'startup-test', HARNESS_DATA_DIR: root,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  closed = once(child, 'exit');
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  let ready = false, writable = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, output);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/cluster/status`, {
        headers: { 'x-harness-token': 'startup-test' }, signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        ready = true;
        const status = await response.json();
        assert.equal(status.mode, 'two-host availability');
        writable = status.writable;
        if (writable) break;
      }
    } catch { /* The listener may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.ok(ready, `HTTP startup must not require a coordinator: ${output}`);
  assert.ok(writable, `The surviving paired computer must elect itself: ${output}`);
  console.log('PASS paired server starts and becomes writable with its peer offline');
} finally {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  if (closed) await closed;
  await fs.rm(root, { recursive: true, force: true });
}
