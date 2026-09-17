import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load, update, listWithStatus } from '../src/core/apps.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-history-'));
try {
  const app = { id: 'simulation', name: 'SimulationSwarm', start: '', dir: '/example', lastStartedAt: null };
  await fs.writeFile(path.join(dir, 'apps.json'), JSON.stringify({ apps: [app] }));
  assert.equal((await load(dir)).find(a => a.id === app.id).hasBeenApp, false);
  // Simulate a legacy observation, including its persisted flag and marker.
  app.hasBeenApp = true;
  await fs.writeFile(path.join(dir, 'apps.json'), JSON.stringify({ apps: [app] }));
  await fs.mkdir(path.join(dir, 'app-history'));
  await fs.writeFile(path.join(dir, 'app-history', app.id + '.json'), '{}');
  const repaired = (await load(dir)).find(a => a.id === app.id);
  assert.equal(repaired.hasBeenApp, false);
  const status = (await listWithStatus(dir)).find(a => a.id === app.id);
  assert.equal(status.running, false);
  assert.equal(status.hasBeenApp, false);
  assert.equal(status.urls.desktop, null);
  await update(dir, app.id, { start: 'npm start' });
  assert.equal((await load(dir)).find(a => a.id === app.id).hasBeenApp, true);
  await update(dir, app.id, { start: '', hasBeenApp: false });
  assert.equal((await load(dir)).find(a => a.id === app.id).hasBeenApp, true);
  const configured = { id: 'configured', name: 'Configured', start: 'npm start' };
  await fs.writeFile(path.join(dir, 'apps.json'), JSON.stringify({ apps: [configured] }));
  await load(dir);
  configured.start = '';
  await fs.writeFile(path.join(dir, 'apps.json'), JSON.stringify({ apps: [configured] }));
  assert.equal((await load(dir)).find(a => a.id === configured.id).hasBeenApp, true);
  console.log('PASS app history survives stop, reload, command removal; legacy detected-only workspaces are repaired');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
