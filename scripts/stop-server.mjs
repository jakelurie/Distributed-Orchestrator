// Stop only this checkout's Node server; never kill an arbitrary port occupant.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function listeners(port) {
  try {
    return [...new Set(execFileSync('lsof', ['-nP', '-a', '-iTCP:' + port, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', timeout: 3000 }).trim().split(/\s+/).filter(Boolean))];
  } catch (e) {
    if (e.status === 1 && !String(e.stdout || '').trim()) return [];
    throw e;
  }
}

export function matchesServer(command, cwd, root) {
  const parts = command.trim().split(/\s+/);
  if (!/^node(?:js)?$/.test(path.basename(parts[0] || ''))) return false;
  try {
    return parts.slice(1).some((arg) => !arg.startsWith('-') &&
      realpathSync(path.resolve(cwd, arg)) === realpathSync(path.join(root, 'server/index.js')));
  } catch { return false; }
}

export async function stopServer(root, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port');
  const pids = listeners(port);
  for (const pid of pids) {
    const command = execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8', timeout: 3000 });
    const fields = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 3000 });
    const cwd = fields.split('\n').find((line) => line.startsWith('n'))?.slice(1);
    if (!cwd || !matchesServer(command, cwd, root)) throw new Error('Port belongs to another program; it was not stopped.');
  }
  for (const pid of pids) {
    try { process.kill(Number(pid), 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  // Include a quiet period to detect a service manager immediately restarting it.
  let quiet = 0;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 250));
    quiet = listeners(port).length ? 0 : quiet + 1;
    if (quiet >= 4) return;
  }
  throw new Error('Server is still running or was restarted by a service. Disable that service, then retry.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stopServer(process.argv[2], Number(process.argv[3])).catch((e) => {
    console.error(e.message); process.exitCode = 1;
  });
}
