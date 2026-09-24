import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { complete } from '../src/core/providers/codex-cli.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-stdin-'));
try {
  const bin = path.join(dir, 'codex');
  await fs.writeFile(bin, `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  require('fs').writeFileSync('captured.json', JSON.stringify({ args: process.argv.slice(2), input }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
});
`, { mode: 0o755 });
  const system = 'Harness instructions '.repeat(2000);
  const result = await complete({ client: { bin }, spec: { model: 'test' }, system,
    events: [{ type: 'user', text: 'Test this machine' }], cwd: dir });
  assert.equal(result.error, undefined);
  const captured = JSON.parse(await fs.readFile(path.join(dir, 'captured.json')));
  assert.ok(captured.args.join(' ').length < 100);
  assert.equal(captured.args.at(-1), '-');
  assert.ok(captured.input.startsWith(system));
  assert.match(captured.input, /Test this machine/);
  assert.ok(captured.args.includes('--dangerously-bypass-approvals-and-sandbox'), 'Codex sandbox is off by default');
  await complete({ client: { bin }, spec: { model: 'test', sandbox: true }, system: '',
    events: [{ type: 'user', text: 'x' }], cwd: dir });
  const sandboxed = JSON.parse(await fs.readFile(path.join(dir, 'captured.json')));
  assert.ok(!sandboxed.args.includes('--dangerously-bypass-approvals-and-sandbox'), 'sandbox: true keeps it');
  console.log('PASS large Codex instructions travel through stdin, not Windows command arguments; sandbox off unless asked');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
