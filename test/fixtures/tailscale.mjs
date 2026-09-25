// Loaded only by the E2E runner and its child processes. Node works on Windows
// too, where execFile cannot execute a shebang script as a client substitute.
import fs from 'node:fs';
import path from 'node:path';

const command = path.basename(process.argv[1] || '');
if (command === 'status' || command === 'serve') {
  const state = process.env.HARNESS_TEST_TAILSCALE_STATE;
  const value = command === 'status'
    ? { BackendState: state ? fs.readFileSync(state, 'utf8').trim() : 'Running' }
    : {};
  fs.writeSync(1, JSON.stringify(value));
  process.exit(0);
}
