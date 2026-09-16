import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load, rememberApp, update } from '../src/core/apps.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-history-'));
try {
  const app = { id: 'simulation', name: 'SimulationSwarm', start: '', dir: '/example', lastStartedAt: null };
  await fs.writeFile(path.join(dir, 'apps.json'), JSON.stringify({ apps: [app] }));
  assert.equal((await load(dir)).find(a => a.id === app.id).hasBeenApp, false);
  await Promise.all([rememberApp(dir, app), rememberApp(dir, { ...app })]);
  assert.equal((await load(dir)).find(a => a.id === app.id).hasBeenApp, true);
  await update(dir, app.id, { start: '', hasBeenApp: false });
  assert.equal((await load(dir)).find(a => a.id === app.id).hasBeenApp, true);
  const configured = { id: 'configured', name: 'Configured', start: 'npm start' };
  await fs.writeFile(path.join(dir, 'apps.json'), JSON.stringify({ apps: [configured] }));
  await load(dir);
  configured.start = '';
  await fs.writeFile(path.join(dir, 'apps.json'), JSON.stringify({ apps: [configured] }));
  assert.equal((await load(dir)).find(a => a.id === configured.id).hasBeenApp, true);
  console.log('PASS app history survives stop, reload, command removal, and concurrent observations');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
