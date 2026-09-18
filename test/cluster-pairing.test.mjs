import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hostPairing } from '../src/core/cluster/pairing.js';
import { createCluster } from '../src/core/cluster/index.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pairing-'));
const clusters = [];
try {
  let time = Date.now();
  const systems = new Map();
  const devices = [
    { dns: 'main.example.ts.net', active: true, name: 'Main', platform: 'macOS' },
    { dns: 'new.example.ts.net', active: true, name: 'New', platform: 'windows' },
    { dns: 'phone.example.ts.net', active: true, platform: 'iOS' },
  ];
  const calls = [];
  const request = async (url, options) => {
    assert.equal(options.redirect, 'error');
    calls.push(url);
    const system = systems.get(new URL(url).origin);
    if (!system) throw Error('offline');
    if (!options.body) return { ok: true, json: async () => system.pairing.status() };
    const body = JSON.parse(options.body);
    if (body.action === 'request') await system.pairing.announce(body.url);
    else await system.pairing.accept(body);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const make = async (name, url) => {
    const cluster = await createCluster(path.join(root, name));
    clusters.push(cluster);
    await cluster.setUrl(url);
    const system = { cluster, joins: [] };
    system.pairing = hostPairing({ cluster, now: () => time, request,
      inventory: async () => ({ devices: devices.map(d => ({ ...d, local: d.dns === new URL(url).hostname })) }),
      join: async body => {
        const main = systems.get(body.url).cluster;
        assert.ok(main.validInvite(body.token));
        assert.ok(main.matchesInvite(cluster.self));
        main.consumeInvite();
        system.joins.push(body);
      },
    });
    systems.set(url, system); return system;
  };
  const main = await make('main', 'https://main.example.ts.net');
  const newcomer = await make('new', 'https://new.example.ts.net:8555');
  const discovery = await newcomer.pairing.discover();
  assert.equal(discovery.hosts.length, 1);
  assert.equal(discovery.hosts[0].node, main.cluster.self.id);
  assert.ok(!calls.some(url => url.includes('phone.')));
  assert.equal(newcomer.joins.length, 0, 'discovery grants no membership');
  await assert.rejects(main.pairing.approve(newcomer.cluster.self.url));
  assert.throws(() => newcomer.pairing.accept({ token: 'bad' }));
  for (const url of ['http://main.example.ts.net', 'https://evil.example', 'https://main.example.ts.net/path', 'https://user@main.example.ts.net']) {
    await assert.rejects(newcomer.pairing.requestJoin(url));
  }
  await newcomer.pairing.requestJoin(main.cluster.self.url);
  assert.equal(newcomer.joins.length, 0, 'request awaits explicit approval');
  const pending = newcomer.pairing.status().pending;
  assert.throws(() => newcomer.pairing.accept({ nonce: 'wrong', token: 'bad' }));
  assert.ok((await main.pairing.discover()).hosts.some(h => h.url === newcomer.cluster.self.url), 'custom-port requests announce themselves');
  await main.pairing.approve(newcomer.cluster.self.url);
  assert.equal(newcomer.joins.length, 1);
  assert.equal(newcomer.joins[0].url, main.cluster.self.url);
  assert.equal(newcomer.pairing.status().pending, null);
  assert.throws(() => newcomer.pairing.accept({ nonce: pending.nonce, token: 'replay' }));
  assert.equal(main.cluster.validInvite(newcomer.joins[0].token), false);
  await newcomer.pairing.requestJoin(main.cluster.self.url);
  time += 600001;
  await assert.rejects(main.pairing.approve(newcomer.cluster.self.url));
  assert.equal(newcomer.pairing.status().pending, null);
  await newcomer.pairing.requestJoin(main.cluster.self.url);
  newcomer.pairing.cancel();
  await assert.rejects(main.pairing.approve(newcomer.cluster.self.url));
  const scoped = main.cluster.invite(newcomer.cluster.self);
  assert.ok(main.cluster.validInvite(scoped.code));
  assert.equal(main.cluster.matchesInvite({ ...newcomer.cluster.self, id: main.cluster.self.id }), false);
  assert.equal(main.cluster.matchesInvite({ ...newcomer.cluster.self, url: main.cluster.self.url }), false);
  const down = hostPairing({ cluster: newcomer.cluster, inventory: async () => ({ devices, error: 'unavailable' }), request });
  await assert.rejects(down.requestJoin(main.cluster.self.url));
  assert.equal((await down.discover()).hosts.length, 0);
  // A host without an HTTPS address publishes one when asked to join,
  // instead of sending the user off to set up Phone access first.
  devices.push({ dns: 'lazy.example.ts.net', active: true, name: 'Lazy', platform: 'linux' });
  const bare = await createCluster(path.join(root, 'bare'));
  clusters.push(bare);
  let published = 0;
  const lazy = hostPairing({ cluster: bare, now: () => time, request, inventory: async () => ({ devices }),
    publish: async () => { published++; await bare.setUrl('https://lazy.example.ts.net'); } });
  systems.set('https://lazy.example.ts.net', { cluster: bare, pairing: lazy });
  await lazy.requestJoin(main.cluster.self.url);
  assert.equal(published, 1);
  assert.equal(lazy.status().pending.target, main.cluster.self.id);
  const unpublished = await createCluster(path.join(root, 'stuck'));
  clusters.push(unpublished);
  const stuck = hostPairing({ cluster: unpublished, request, inventory: async () => ({ devices }),
    publish: async () => { throw new Error('Tailscale must allow HTTPS'); } });
  await assert.rejects(stuck.requestJoin(main.cluster.self.url), /allow HTTPS/);
  const ui = await fs.readFile('server/public/app.js', 'utf8');
  const sheet = ui.slice(ui.indexOf('async function machinesSheet()'), ui.indexOf('async function modelsSheet()'));
  assert.doesNotMatch(sheet, /cluster-token|cluster-invite|create join code/);
  assert.match(sheet, /Approve host/);
  assert.match(sheet, /sets up this computer’s private Tailscale HTTPS address automatically/);
  console.log('PASS discovery, explicit approval, custom ports, host-bound credentials, expiry, cancellation, replay and address restrictions');
} finally {
  for (const cluster of clusters) cluster.replica.stop();
  await fs.rm(root, { recursive: true, force: true });
}
