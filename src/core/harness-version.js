// Compare live processes, never infer a running version from a peer's checkout.
export async function harnessVersions(cluster, local, { request = fetch } = {}) {
  const hosts = await Promise.all(cluster.replica.members().map(async host => {
    try {
      let status = local;
      if (host.id !== cluster.self.id) {
        const response = await request(new URL('/api/harness/status', host.url), {
          headers: { 'x-cluster-key': cluster.replica.disk.secret }, redirect: 'error',
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('unavailable');
        status = await response.json();
        if (status.node !== host.id) throw new Error('identity mismatch');
      }
      const version = status.version;
      const update = status.update || {};
      const state = !version?.revision ? 'Version unavailable — update this machine'
        : update.restartRequired ? 'Restart needed'
        : update.available ? `Update available${update.skipped ? `: ${update.skipped}` : ''}`
        : version.dirty ? 'Local edits at startup'
        : version.revision !== local.version.revision ? 'Different commit — check updates'
        : update.error ? 'Update check failed'
        : update.skipped ? `Update check paused: ${update.skipped}` : 'Same running commit';
      return { id: host.id, name: host.name, version, update, state, busy: Boolean(status.busy), restarting: Boolean(status.restarting) };
    } catch { return { id: host.id, name: host.name, state: 'Unreachable — version unverified' }; }
  }));
  return { version: local.version, hosts, checkedAt: new Date().toISOString(),
    aligned: hosts.length > 0 && hosts.every(h => h.state === 'Same running commit') };
}
