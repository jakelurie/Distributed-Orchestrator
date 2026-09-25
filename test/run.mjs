// Run a small set of real-server E2E workflows with deterministic external services.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = path.join(root, 'test/e2e');
const fixture = new URL('./fixtures/tailscale.mjs', import.meta.url).href;
const suites = readdirSync(dir).filter(file => file.endsWith('.test.mjs')).sort();
if (!suites.length) throw new Error('No E2E tests found');
let failed = 0;
for (const file of suites) {
  console.log(`E2E: ${file}`);
  const result = spawnSync(process.execPath, [path.join(dir, file)], {
    cwd: root, stdio: 'inherit', timeout: 180_000,
    env: { ...process.env, ORCHESTRATOR_TAILSCALE_BIN: process.execPath,
      ORCHESTRATOR_TAILSCALE_SOCKET: '', HARNESS_TEST_TAILSCALE_STATE: '',
      NODE_OPTIONS: `--import=${fixture}` },
  });
  if (result.status !== 0) {
    failed++;
    console.error(result.error?.message || `Suite exited with ${result.status ?? result.signal}`);
  }
}
console.log(`${suites.length - failed}/${suites.length} E2E workflows passed`);
process.exitCode = failed ? 1 : 0;
