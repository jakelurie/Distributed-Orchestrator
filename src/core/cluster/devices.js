import fs from 'node:fs/promises';
import path from 'node:path';
import { tailscale } from '../tailscale.js';
import { atomic } from './raft.js';

/** Inventory only: seeing a tailnet device never grants it cluster access. */
export function deviceInventory(dir, run = tailscale) {
  const file = path.join(dir, 'cluster', 'devices.json');
  let cached, checked = 0, pending;
  return async () => {
    if (pending) return pending;
    if (cached && Date.now() - checked < 30000) return cached;
    pending = (async () => {
      const old = await fs.readFile(file, 'utf8').then(JSON.parse).catch((e) => { if (e.code === 'ENOENT') return {}; throw e; });
      let error = '';
      for (const value of Object.values(old)) value.active = false;
      try {
        const status = JSON.parse((await run(['status', '--json'])).stdout);
        for (const peer of [status.Self, ...Object.values(status.Peer || {})].filter(Boolean)) {
          const id = peer.ID || peer.PublicKey;
          if (!id) continue;
          const previous = old[id];
          old[id] = { id, name: peer.HostName || peer.DNSName, dns: peer.DNSName?.replace(/\.$/, ''),
            addresses: peer.TailscaleIPs || [], platform: peer.OS, active: Boolean(peer.Online),
            firstSeen: previous?.firstSeen || Date.now(), lastSeen: peer.Online ? Date.now() : Date.parse(peer.LastSeen) || previous?.lastSeen || null,
            local: peer === status.Self };
        }
      } catch { error = 'Tailscale inventory unavailable; showing previously seen devices.'; }
      await atomic(file, old);
      checked = Date.now(); cached = { devices: Object.values(old), error }; return cached;
    })().finally(() => { pending = null; });
    return pending;
  };
}
