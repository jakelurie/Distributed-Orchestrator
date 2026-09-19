/** Durable turn tracking. Git integration serializes writes, not turn numbers. */
export const queueKey = session => `turn-queue:${session.appId || session.id}`;
export const unfinished = entry => !['done', 'cancelled'].includes(entry.state);
export const activeTurn = entry => unfinished(entry) && entry.state !== 'blocked';
export function queueChange(previous, action) {
  const queue = structuredClone(previous || { next: 1, entries: [] });
  if (action.op === 'enqueue') {
    if (queue.entries.some(e => e.id === action.entry.id)) return queue;
    const pending = queue.entries.filter(e => e.sessionId === action.entry.sessionId && unfinished(e));
    const blocked = pending.find(e => e.state === 'blocked');
    if (blocked && pending.every(e => e.state === 'blocked')) {
      if (blocked.owner !== action.entry.owner) throw new Error('Only the owning computer can resume this queue entry.');
      // Retain the failed request's history when a new message resumes it.
      // Turn numbers are identifiers, not publication reservations.
      blocked.attempts = [...(blocked.attempts || []), { id: blocked.id, detail: blocked.detail }];
      Object.assign(blocked, action.entry, { number: blocked.number, state: 'queued', detail: '', kind: action.entry.kind });
      return queue;
    }
    if (pending.length && !action.allowQueue) throw new Error('A turn is already running. Use Queue next.');
    if (pending.some(e => e.state === 'queued')) throw new Error('This tab already has a queued message. Your draft has been kept.');
    queue.entries.push({ ...action.entry, number: queue.next++, state: 'queued' });
    return queue;
  }
  const entry = queue.entries.find(e => e.id === action.id);
  if (!entry) throw new Error('Queue entry not found.');
  if (entry.owner !== action.owner) throw new Error('Only the owning computer can update this queue entry.');
  if (action.op === 'claim') {
    if (entry.state !== 'ready') throw new Error('This turn is not ready to publish.');
    entry.state = 'publishing';
    return queue;
  }
  if (action.state === 'preparing' && queue.entries.some(e => e.sessionId === entry.sessionId && e.number < entry.number && activeTurn(e)))
    throw new Error('An earlier turn in this tab still needs recovery.');
  const allowed = {
    queued: ['preparing', 'cancelled', 'blocked'], preparing: ['ready', 'blocked', 'done'],
    ready: ['blocked'], publishing: ['done', 'blocked'], blocked: ['ready', 'cancelled'],
  };
  if (entry.state === action.state) return queue;
  if (!allowed[entry.state]?.includes(action.state)) throw new Error(`Cannot change ${entry.state} to ${action.state}.`);
  if (action.state === 'preparing') {
    // A follow-up already queued when its predecessor failed must still run.
    const blocked = queue.entries.filter(e => e.sessionId === entry.sessionId && e.number < entry.number && e.state === 'blocked');
    if (blocked.some(e => e.owner !== action.owner)) throw new Error('Only the owning computer can resume this queue entry.');
    if (blocked.length) entry.attempts = [...(entry.attempts || []), ...blocked.map(e => ({ id: e.id, detail: e.detail }))];
    for (const previous of blocked) {
      previous.state = 'cancelled';
      previous.detail = `Continued by turn #${entry.number}. ${previous.detail || ''}`.slice(0, 1000);
      delete previous.body;
    }
  }
  entry.state = action.state;
  entry.detail = String(action.detail || '').slice(0, 1000);
  if (!unfinished(entry)) delete entry.body;
  return queue;
}

/** Serialize the read/modify/commit sequence, not just individual disk writes. */
export function projectQueue({ read, write }) {
  const pending = new Map();
  return {
    read,
    async change(key, action) {
      if (!key.startsWith('turn-queue:')) throw new Error('Invalid queue.');
      const task = (pending.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
        const value = queueChange(await read(key), action);
        await write(key, value);
        return value;
      });
      pending.set(key, task);
      try { return await task; } finally { if (pending.get(key) === task) pending.delete(key); }
    },
  };
}
