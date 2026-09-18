import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { Replica, atomic, quorum } from './raft.js';

const sameSecret = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
export async function createCluster(dir, { port, request = fetch, onChange = () => {} } = {}) {
  const root = path.join(dir, 'cluster');
  const identityFile = path.join(root, 'identity.json');
  let self;
  try { self = JSON.parse(await fs.readFile(identityFile, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    self = { id: crypto.randomUUID(), name: process.env.ORCHESTRATOR_NODE_NAME || os.hostname(),
      platform: process.platform, url: process.env.ORCHESTRATOR_PUBLIC_URL || '', joinedAt: Date.now() };
    await atomic(identityFile, self);
  }
  const replica = new Replica(root, { self, onChange, send: (node, message) => rpc(node.url, 'rpc', message) });
  await replica.init();
  async function rpc(origin, route, body, token) {
    const payload = JSON.stringify(body);
    // Elections must notice a switched-off host quickly; bulk catch-up and
    // snapshots get time proportional to their size (at least ~500 KB/s).
    const timeout = ['admit', 'activate'].includes(route) ? 90000
      : ['vote', 'prevote'].includes(body?.kind) ? 2500 : 5000 + Math.ceil(payload.length / 500_000) * 1000;
    const response = await request(new URL(`/api/cluster/${route}`, origin), {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json',
        ...(token ? { 'x-harness-token': token } : { 'x-cluster-key': replica.disk.secret }) },
      body: payload, signal: AbortSignal.timeout(timeout),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `Machine returned ${response.status}`);
    return value;
  }
  let joinPending = false;
  let invitation;
  const service = {
    replica, self,
    invite(member) {
      if (!replica.writable()) throw new Error('Create the join code on the current main host.');
      if (!self.url) throw new Error('Set up Phone access first so the new host can reach this machine.');
      invitation = { code: crypto.randomBytes(24).toString('base64url'), expires: Date.now() + 10 * 60000, url: self.url };
      if (member) invitation.member = member;
      return { ...invitation };
    },
    validInvite(code) { return invitation?.expires > Date.now() && sameSecret(code, invitation.code); },
    matchesInvite(member) { return !invitation?.member || (invitation.member.id === member?.id && invitation.member.url === member?.url); },
    consumeInvite() { invitation = null; },
    trusted(req) { return sameSecret(req.headers['x-cluster-key'], replica.disk.secret); },
    shared() { return replica.members().length > 1; },
    leader() { return replica.members().find((n) => n.id === replica.leader); },
    async setUrl(url) {
      if (!url || service.shared()) return;
      const u = new URL(url); if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Invalid host address');
      self.url = u.origin;
      await atomic(identityFile, self);
      await replica.setStandalone(self);
    },
    ticket() {
      const payload = Buffer.from(JSON.stringify({ cluster: replica.disk.clusterId, expires: Date.now() + 7 * 86400000 })).toString('base64url');
      return `cluster.${payload}.${crypto.createHmac('sha256', replica.disk.secret).update(payload).digest('hex')}`;
    },
    verifyTicket(value) {
      if (typeof value !== 'string') return false;
      const [, payload, signature] = value.split('.');
      if (!value.startsWith('cluster.') || !payload || !signature) return false;
      if (!sameSecret(signature, crypto.createHmac('sha256', replica.disk.secret).update(payload).digest('hex'))) return false;
      try { const data = JSON.parse(Buffer.from(payload, 'base64url')); return data.cluster === replica.disk.clusterId && data.expires > Date.now(); }
      catch { return false; }
    },
    status() {
      const now = Date.now();
      const members = replica.members();
      const seen = (id) => Math.max(replica.lastContact.get(id) || 0, replica.sightings?.[id] || 0, replica.state.values['host-seen:' + id] || 0);
      return { id: replica.disk.clusterId, self: self.id, leader: replica.leader, preferred: replica.state.preferred,
        role: replica.role, writable: replica.writable(), term: replica.disk.term,
        conflicts: replica.disk.conflicts || 0, committed: replica.disk.commit, replicated: replica.length(),
        mode: members.length === 1 ? 'standalone' : members.length === 2 ? 'two-host availability' : 'majority consensus',
        quorum: quorum(members.length),
        recoveryIssues: Object.values(replica.state.sessions).filter((s) => s.workspaceError).map((s) => ({ session: s.name, error: s.workspaceError })),
        hosts: Object.values({ ...replica.state.history, ...Object.fromEntries(members.map((n) => [n.id, n])) }).map((n) => ({
          ...n, active: n.id === self.id || now - seen(n.id) < 15000,
          lastSeen: n.id === self.id ? now : seen(n.id) || null,
          member: members.some((m) => m.id === n.id),
        })),
        viewers: Object.values(replica.state.viewers).map((v) => ({ ...v, active: now - v.lastSeen < 45000 })),
      };
    },
    async command(command) {
      if (replica.role === 'leader') return replica.propose(command);
      const leader = service.leader();
      if (!leader) throw new Error('Choosing a coordinator. Retry after the machines reconnect.');
      await rpc(leader.url, 'command', command);
    },
    async viewer(body, userAgent) {
      if (!/^[a-zA-Z0-9-]{16,80}$/.test(body.id || '')) throw new Error('Invalid viewer identity');
      const old = replica.state.viewers[body.id];
      const now = Date.now();
      const value = { id: body.id, name: String(body.name || old?.name || (/iPhone|Android.*Mobile/i.test(userAgent) ? 'Phone browser' : 'Computer browser')).slice(0, 100),
        kind: /iPhone|Android.*Mobile/i.test(userAgent) ? 'phone' : /iPad|Tablet/i.test(userAgent) ? 'tablet' : 'browser',
        firstSeen: old?.firstSeen || now, lastSeen: now, hostId: self.id };
      await service.command({ type: 'viewer', value });
      return { ...service.status(), ticket: service.ticket() };
    },
    async join({ url, token, ownUrl }, sessions = [], values = {}) {
      if (joinPending || service.shared()) throw new Error('This machine is already joined or joining.');
      if (!token?.trim()) throw new Error('Enter the existing host’s access token.');
      const target = new URL(url);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || target.pathname !== '/') throw new Error('Enter a machine origin without credentials or a path.');
      await service.setUrl(ownUrl || self.url);
      if (!self.url) throw new Error('Set up this machine’s Phone access first.');
      if (new URL(self.url).origin === target.origin) throw new Error('This is the same machine.');
      joinPending = true;
      replica.stop();
      try {
        const admitted = await rpc(target.origin, 'admit', { member: self }, token.trim());
        // Preserve the old standalone history before adopting the cluster.
        await atomic(path.join(root, `before-join-${Date.now()}.json`), replica.exportState());
        await replica.importState(admitted.disk ? admitted : { disk: admitted, snapshot: null });
        await rpc(target.origin, 'activate', { member: self });
        // Joining an existing installation imports its transcripts, retaining
        // distinct IDs rather than overwriting an existing cluster session.
        for (const [id, value] of Object.entries(values)) await rpc(target.origin, 'command', { type: 'value', id, value });
        for (const session of sessions) {
          if (replica.state.sessions[session.id] || replica.disk.log.some((e) => e.command.type === 'session' && e.command.id === session.id)) {
            session.id += `-${self.id.slice(0, 8)}`;
          }
          await rpc(target.origin, 'command', { type: 'session', id: session.id, value: { ...session, ownerNode: self.id } });
        }
      } finally { joinPending = false; replica.start(); }
      return service.status();
    },
    async admit(member) {
      if (!replica.writable()) throw new Error('Join through the active coordinator.');
      if (!member || !/^[a-f0-9-]{36}$/.test(member.id) || typeof member.name !== 'string') throw new Error('Invalid host identity');
      const u = new URL(member.url);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Invalid host origin');
      if (replica.members().some((n) => n.id === member.id || n.url === u.origin)) throw new Error('Machine already joined');
      // Admit as a learner. Activation waits for it to acknowledge the log
      // before a joint configuration can give it a vote.
      return replica.exportState();
    },
    async activate(member) {
      if (joinPending) throw new Error('A membership change is already running');
      joinPending = true;
      try {
        const old = replica.members();
        if (old.some((n) => n.id === member.id)) return;
        await replica.propose({ type: 'configuration', old, members: [...old, member] });
        await replica.propose({ type: 'configuration', members: [...old, member] });
      } finally { joinPending = false; }
    },
    proxy(req, res) {
      const leader = service.leader();
      if (!leader || leader.id === self.id) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Coordinator election in progress. No operation was replayed.' })); return; }
      const target = new URL(leader.url);
      const headers = { ...req.headers, host: target.host, 'x-cluster-key': replica.disk.secret };
      delete headers.cookie; delete headers['x-harness-token'];
      const upstream = (target.protocol === 'https:' ? https : http).request(target.origin + req.url, { method: req.method, headers }, (reply) => {
        clearTimeout(timeout);
        const responseHeaders = { ...reply.headers }; delete responseHeaders['set-cookie'];
        res.writeHead(reply.statusCode, responseHeaders); reply.pipe(res); reply.on('error', () => res.destroy());
      });
      const timeout = setTimeout(() => upstream.destroy(), 10000);
      upstream.on('error', () => {
        clearTimeout(timeout);
        if (res.headersSent) return res.destroy();
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Coordinator unavailable. Waiting for takeover; this request was not retried.' }));
      });
      res.on('close', () => { clearTimeout(timeout); upstream.destroy(); });
      req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
    },
  };
  return service;
}
