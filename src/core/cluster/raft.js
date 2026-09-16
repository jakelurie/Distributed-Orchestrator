/** Durable replicated log. No execution is replayed when a coordinator changes.
 * One voter is standalone; two deliberately favour availability during a split.
 * Three and up require a majority, including both sets during membership changes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const quorum = (n) => n < 3 ? 1 : Math.floor(n / 2) + 1;
const copy = (value) => structuredClone(value);
export async function atomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(tmp, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(tmp, file);
  // Windows does not support opening directories for fsync; file data was flushed above.
  if (process.platform === 'win32') return;
  const directory = await fs.open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export class Replica {
  constructor(dir, { self, send, now = () => performance.now(), random = Math.random, onChange = () => {} }) {
    Object.assign(this, { dir, self, send, now, random, onChange });
    this.file = path.join(dir, 'replica.json');
    this.role = 'follower'; this.leader = null; this.lastContact = new Map();
    this.next = new Map(); this.match = new Map(); this.queue = Promise.resolve();
    this.proposals = Promise.resolve(); this.busy = false; this.lastQuorum = -Infinity;
  }
  async init() {
    try { this.disk = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.disk = { clusterId: crypto.randomUUID(), secret: crypto.randomBytes(32).toString('hex'), term: 0,
        votedFor: null, commit: 0, log: [], initial: [this.self] };
      await this.persist();
    }
    this.rebuild(); this.resetElection();
    if (this.members().length === 1) await this.campaign();
    return this;
  }
  exclusive(fn) {
    const task = this.queue.catch(() => {}).then(fn); this.queue = task; return task;
  }
  persist() { return atomic(this.file, this.disk); }
  resetElection() {
    const preferred = this.state?.preferred === this.self.id;
    this.deadline = this.now() + (preferred ? 3500 : 5000) + this.random() * 1500;
  }
  configuration() {
    const entry = this.disk.log.findLast((e) => e.command.type === 'configuration');
    return entry?.command || { members: this.disk.initial };
  }
  members() {
    const config = this.configuration();
    return [...new Map([...(config.old || []), ...config.members].map((n) => [n.id, n])).values()];
  }
  enough(ids) {
    const c = this.configuration();
    const count = (members) => members.filter((n) => ids.has(n.id)).length;
    // Joint transitions require an actual old majority, even for a two-host
    // availability cluster: both hosts must acknowledge upgrading to three.
    return count(c.members) >= (c.old ? Math.floor(c.members.length / 2) + 1 : quorum(c.members.length)) &&
      (!c.old || count(c.old) >= Math.floor(c.old.length / 2) + 1);
  }
  rebuild() {
    const state = { sessions: {}, viewers: {}, preferred: this.disk.initial[0].id, history: {}, values: {} };
    for (const node of this.disk.initial) state.history[node.id] = node;
    for (const { command: c } of this.disk.log.slice(0, this.disk.commit)) {
      if (c.type === 'session') {
        if (c.value === null) delete state.sessions[c.id]; else state.sessions[c.id] = c.value;
      } else if (c.type === 'viewer') state.viewers[c.value.id] = c.value;
      else if (c.type === 'preferred') state.preferred = c.id;
      else if (c.type === 'configuration') for (const node of c.members) state.history[node.id] = node;
      else if (c.type === 'value') state.values[c.id] = c.value;
    }
    this.state = state;
    this.onChange(this);
  }
  stepDown(term) {
    if (term > this.disk.term) { this.disk.term = term; this.disk.votedFor = null; }
    this.role = 'follower'; this.leader = null; this.lastQuorum = -Infinity;
  }
  writable() {
    return this.role === 'leader' && this.now() - this.lastQuorum < 3000 &&
      this.disk.log[this.disk.commit - 1]?.term === this.disk.term;
  }
  async receive(message) {
    return this.exclusive(async () => {
      if (!this.members().some((n) => n.id === message.from)) throw new Error('Unknown cluster member');
      if (message.term > this.disk.term) { this.stepDown(message.term); await this.persist(); }
      if (message.term < this.disk.term) return { term: this.disk.term, ok: false };
      this.lastContact.set(message.from, Date.now());
      if (message.kind === 'vote') {
        const last = this.disk.log.at(-1);
        const current = !last || message.lastTerm > last.term ||
          (message.lastTerm === last.term && message.lastIndex >= this.disk.log.length);
        const ok = current && (!this.disk.votedFor || this.disk.votedFor === message.from);
        if (ok) { this.disk.votedFor = message.from; this.resetElection(); await this.persist(); }
        return { term: this.disk.term, ok };
      }
      if (message.kind !== 'append') throw new Error('Unknown cluster message');
      this.role = 'follower'; this.leader = message.from; this.resetElection();
      this.disk.sightings = { ...(message.sightings || {}), [message.from]: Date.now() };
      if (message.prev > this.disk.log.length || (message.prev && this.disk.log[message.prev - 1].term !== message.prevTerm)) {
        return { term: this.disk.term, ok: false, length: this.disk.log.length };
      }
      let index = message.prev;
      for (const entry of message.entries) {
        const old = this.disk.log[index];
        if (old && (old.term !== entry.term || old.id !== entry.id)) {
          if (index < this.disk.commit) {
            if (this.members().length >= 3) throw new Error('Refusing to replace a committed majority log');
            // Two isolated hosts can both accept changes. Keep the losing
            // branch on disk for recovery; never silently erase its transcript.
            await atomic(path.join(this.dir, `conflict-${Date.now()}-${crypto.randomUUID()}.json`), this.disk);
            this.disk.commit = index;
            this.disk.conflicts = (this.disk.conflicts || 0) + 1;
          }
          this.disk.log.length = index;
        }
        if (!this.disk.log[index]) this.disk.log.push(copy(entry));
        index++;
      }
      this.disk.commit = Math.max(this.disk.commit, Math.min(message.commit, index));
      await this.persist(); this.rebuild();
      return { term: this.disk.term, ok: true, length: index };
    });
  }
  async campaign() {
    if (!this.members().some((n) => n.id === this.self.id)) return;
    const request = await this.exclusive(async () => {
      this.role = 'candidate'; this.leader = null; this.disk.term++; this.disk.votedFor = this.self.id;
      this.resetElection(); await this.persist();
      return { kind: 'vote', from: this.self.id, term: this.disk.term,
        lastIndex: this.disk.log.length, lastTerm: this.disk.log.at(-1)?.term || 0 };
    });
    const votes = new Set([this.self.id]);
    await Promise.all(this.members().filter((n) => n.id !== this.self.id).map(async (node) => {
      try {
        const response = await this.send(node, request);
        await this.exclusive(async () => {
          if (response.term > this.disk.term) { this.stepDown(response.term); await this.persist(); }
          if (response.term === request.term && response.ok) votes.add(node.id);
        });
      } catch { /* Unreachable voters are never counted. */ }
    }));
    await this.exclusive(async () => {
      if (this.role !== 'candidate' || this.disk.term !== request.term || !this.enough(votes)) return;
      this.role = 'leader'; this.leader = this.self.id; this.lastQuorum = this.now();
      for (const n of this.members()) { this.next.set(n.id, this.disk.log.length + 1); this.match.set(n.id, 0); }
      this.disk.log.push({ term: this.disk.term, id: crypto.randomUUID(), command: { type: 'noop' } });
      await this.persist();
    });
    if (this.role === 'leader') await this.replicate();
  }
  async replicate() {
    if (this.replicating) return this.replicating;
    this.replicating = this._replicate().finally(() => { this.replicating = null; });
    return this.replicating;
  }
  async _replicate() {
    if (this.role !== 'leader') return;
    const term = this.disk.term;
    const acknowledgements = new Set([this.self.id]);
    await Promise.all(this.members().filter((n) => n.id !== this.self.id).map(async (node) => {
      try {
        const next = this.next.get(node.id) || 1;
        const prev = next - 1;
        const entries = [];
        let bytes = 0;
        for (const entry of this.disk.log.slice(prev, prev + 32)) {
          const size = Buffer.byteLength(JSON.stringify(entry));
          if (entries.length && bytes + size > 32_000_000) break;
          entries.push(copy(entry)); bytes += size;
        }
        const response = await this.send(node, { kind: 'append', from: this.self.id, term,
          prev, prevTerm: this.disk.log[prev - 1]?.term || 0, entries, commit: this.disk.commit,
          sightings: { ...this.disk.sightings, ...Object.fromEntries(this.lastContact), [this.self.id]: Date.now() } });
        await this.exclusive(async () => {
          if (response.term > this.disk.term) { this.stepDown(response.term); await this.persist(); return; }
          if (this.role !== 'leader' || this.disk.term !== term) return;
          if (response.ok) {
            this.match.set(node.id, prev + entries.length); this.next.set(node.id, prev + entries.length + 1);
            acknowledgements.add(node.id); this.lastContact.set(node.id, Date.now());
          } else this.next.set(node.id, Math.max(1, Math.min(next - 1, (response.length ?? prev) + 1)));
        });
      } catch { /* Retry catch-up on the next heartbeat. */ }
    }));
    await this.exclusive(async () => {
      if (this.role !== 'leader' || term !== this.disk.term) return;
      if (this.enough(acknowledgements)) this.lastQuorum = this.now();
      this.match.set(this.self.id, this.disk.log.length);
      for (let i = this.disk.log.length; i > this.disk.commit; i--) {
        if (this.disk.log[i - 1].term !== term) continue;
        if (this.enough(new Set([...this.match].filter(([, at]) => at >= i).map(([id]) => id)))) {
          this.disk.commit = i; await this.persist(); this.rebuild(); break;
        }
      }
    });
  }
  propose(command) {
    const task = this.proposals.catch(() => {}).then(async () => {
      if (!this.writable()) throw new Error('No coordinator quorum. Wait for the machines to reconnect.');
      const term = this.disk.term;
      const id = crypto.randomUUID();
      await this.exclusive(async () => {
        this.disk.log.push({ term, id, command: copy(command) }); await this.persist();
      });
      const deadline = this.now() + 10000;
      do {
        await this.replicate();
        const index = this.disk.log.findIndex((e) => e.id === id);
        if (index >= 0 && index < this.disk.commit) return;
        if (this.role !== 'leader' || this.disk.term !== term) throw new Error('Coordinator changed; the result is uncertain. Refresh before retrying.');
        await new Promise((r) => setTimeout(r, 50));
      } while (this.now() < deadline);
      throw new Error('Replication timed out; the result is uncertain. Refresh before retrying.');
    });
    this.proposals = task; return task;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.role === 'leader') {
        await this.replicate();
        if (!this.writable()) this.stepDown(this.disk.term);
      } else if (this.now() > this.deadline) await this.campaign();
    } finally { this.busy = false; }
  }
  start() { this.timer = setInterval(() => this.tick().catch(() => {}), 700); this.timer.unref(); }
  stop() { clearInterval(this.timer); }
}
