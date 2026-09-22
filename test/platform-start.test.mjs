import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { defaultDataDir, shellCommand, windowsListeners } from '../src/core/platform.js';
import { tailscaleCommand } from '../src/core/tailscale.js';
assert.equal(defaultDataDir('win32', 'C:\\Users\\Test', {}), 'C:\\Users\\Test\\AppData\\Local\\DistributedOrchestrator');
assert.equal(defaultDataDir('win32', 'C:\\Users\\Test', { LOCALAPPDATA: 'D:\\Data' }), 'D:\\Data\\DistributedOrchestrator');
assert.equal(defaultDataDir('darwin', '/Users/test', {}), '/Users/test/Library/Application Support/harness');
assert.deepEqual(shellCommand('npm start', 'win32', {}), ['cmd.exe', ['/d', '/s', '/c', 'npm start']]);
assert.deepEqual(shellCommand('npm start', 'darwin', {}), ['/bin/sh', ['-lc', 'npm start']]);
const list = await windowsListeners(async (bin, args) => {
  assert.equal(bin, 'powershell.exe');
  assert.ok(args.at(-1).includes('Get-NetTCPConnection'));
  return { stdout: '[{"pid":123,"port":4321}]' };
});
assert.deepEqual(list, [{ pid: 123, port: 4321, cwd: null }]);
const client = await tailscaleCommand({ ProgramFiles: 'D:\\Programs' }, 'win32', async (bin) => {
  if (bin === 'tailscale.exe') throw new Error('not on PATH');
  assert.equal(bin, 'D:\\Programs\\Tailscale\\tailscale.exe');
  return { stdout: '{"BackendState":"Running"}' };
});
assert.equal(client[0], 'D:\\Programs\\Tailscale\\tailscale.exe');
for (const file of ['start_windows.cmd', 'start_mac.command']) {
  const text = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(text, /wsl.exe/);
  assert.match(text, /start\.mjs/);
}
console.log('PASS native platform paths, command selection, Windows listeners, Tailscale discovery and launch entry points');

// The restart helper waits for the previous server before starting its replacement.
const { default: os } = await import('node:os');
const { default: path } = await import('node:path');
const { default: net } = await import('node:net');
const { spawn } = await import('node:child_process');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restart helper '));
const blocker = net.createServer((socket) => socket.destroy());
let child;
try {
  await new Promise(r => blocker.listen(0, '0.0.0.0', r));
  const target = path.join(dir, 'server.mjs');
  await fs.writeFile(target, 'console.log("replacement started")');
  child = spawn(process.execPath, ['scripts/restart-server.mjs', String(blocker.address().port), target]);
  let output = '';
  child.stdout.on('data', d => { output += d; });
  const finished = new Promise(r => child.once('exit', r));
  await new Promise(r => setTimeout(r, 450));
  assert.equal(output, '');
  await new Promise(r => blocker.close(r));
  assert.equal(await finished, 0);
  assert.match(output, /replacement started/);
  console.log('PASS portable restart waits for the port and launches paths with spaces');
} finally {
  child?.kill();
  if (blocker.listening) await new Promise(r => blocker.close(r));
  await fs.rm(dir, { recursive: true, force: true });
}
