import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { childEnv, makeClient } from '../src/core/providers/claude-cli.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-path-'));
try {
  const bin = path.join(dir, '.local', 'bin');
  await fs.mkdir(bin, { recursive: true });
  const source = { PATH: '/usr/bin:/bin', CLAUDECODE: '1', CLAUDE_CODE_TEST: '1', KEEP: 'yes' };
  const env = childEnv(source, dir);
  assert.equal(env.PATH, source.PATH + path.delimiter + bin);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_TEST, undefined);
  assert.equal(env.KEEP, 'yes');
  assert.equal(source.CLAUDECODE, '1');
  assert.equal(childEnv({}, dir).PATH, bin);
  assert.equal(makeClient({ bin: '/custom/claude' }).bin, '/custom/claude');
  if (process.platform !== 'win32') {
    await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\nprintf "claude launched"\n', { mode: 0o755 });
    const result = spawnSync(makeClient({}).bin, [], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message);
    assert.equal(result.stdout, 'claude launched');
  }
  console.log('PASS Claude native install launches with a desktop PATH, preserves overrides, and strips nested-session variables');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
