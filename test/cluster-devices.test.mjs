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
  const offline = await deviceInventory(dir, async () => { throw Error('unavailable'); })();
  assert.equal(offline.devices.length, 2); assert.ok(offline.devices.every((d) => !d.active));
  assert.equal(offline.devices.find((d) => d.id === 'phone').lastSeen, first.devices.find((d) => d.id === 'phone').lastSeen);
  assert.ok(offline.error); console.log('PASS network device history persists when devices disappear or Tailscale stops');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
