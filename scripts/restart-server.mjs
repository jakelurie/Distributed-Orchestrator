// Wait for the old listener to close without requiring lsof or a Unix shell.
import net from 'node:net';
import { spawn } from 'node:child_process';
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
let available = false;
for (let i = 0; i < 150; i++) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  available = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
  });
  if (available) break;
}
if (!available) throw new Error('Restart timed out: the port is still in use.');
const child = spawn(process.execPath, [process.argv[3]], { stdio: 'inherit', env: process.env });
child.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code || 0; });
