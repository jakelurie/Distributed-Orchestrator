import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deviceInventory } from '../src/core/cluster/devices.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cluster-inventory-'));
try {
  const mock = async () => ({ stdout: JSON.stringify({ Self: { ID: 'mac', HostName: 'Mac', Online: true, OS: 'macOS' }, Peer: {
    phone: { ID: 'phone', HostName: 'iPhone', Online: true, OS: 'iOS' },
  } }) });
  const first = await deviceInventory(dir, mock)();
  assert.equal(first.devices.length, 2); assert.equal(first.devices.filter((d) => d.local).length, 1);
  const current = await deviceInventory(dir, async () => ({ stdout: JSON.stringify({
    Self: { ID: 'mac', HostName: 'Mac', Online: true },
    Peer: {
      replacement: { ID: 'new-phone', HostName: 'iPhone', LastSeen: '0001-01-01T00:00:00Z' },
      duplicate: { ID: 'new-phone', HostName: 'iPhone', LastSeen: '0001-01-01T00:00:00Z' },
      blank: { ID: 'blank', HostName: ' ' },
    },
  }) }))();
  assert.deepEqual(current.devices.map(d => d.id), ['mac', 'new-phone']);
  assert.equal(current.devices[1].lastSeen, null);
  const persisted = JSON.parse(await fs.readFile(path.join(dir, 'cluster', 'devices.json'), 'utf8'));
  assert.deepEqual(Object.keys(persisted), ['mac', 'new-phone'], 'stale history is replaced');
  const offline = await deviceInventory(dir, async () => { throw Error('unavailable'); })();
  assert.equal(offline.devices.length, 0, 'unavailable inventory does not resurrect stale records');
  assert.ok(offline.error);
  const server = await fs.readFile('server/index.js', 'utf8');
  const route = server.slice(server.indexOf("route === 'devices'"), server.indexOf("if (req.method !== 'POST')", server.indexOf("route === 'devices'")));
  assert.doesNotMatch(route, /replica.state.values/);
  const ui = await fs.readFile('server/public/app.js', 'utf8');
  const row = ui.split('\n').find(line => line.includes("$('tailnet-list').innerHTML"));
  assert.doesNotMatch(row, /lastSeen|firstSeen/);
  console.log('PASS current inventory replaces history, removes blanks and duplicates, and omits invalid dates');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
