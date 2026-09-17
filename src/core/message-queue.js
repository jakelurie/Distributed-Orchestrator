// Keep one follow-up per session on the server, independent of browser lifetime.
// Pending messages are intentionally not persisted across a server restart.
export function createMessageQueue() {
  const active = new Map();
  async function drain(id, entry, task) {
    try { await task.run(); }
    catch (e) { task.onError(e); }
    finally {
      const next = entry.next;
      entry.next = null;
      if (next) void drain(id, entry, next);
      else active.delete(id);
    }
  }
  return {
    get size() { return active.size; },
    busy: id => active.has(id),
    cancel(id) { const entry = active.get(id); if (entry) entry.next = null; },
    submit(id, run, { queue = false, onError = () => {} } = {}) {
      const entry = active.get(id);
      const task = { run, onError };
      if (entry) {
        if (!queue) throw new Error('A turn is already running. Use Queue next.');
        if (entry.next) throw new Error('This tab already has a queued message. Your draft has been kept.');
        entry.next = task;
      } else {
        const fresh = { next: null };
        active.set(id, fresh);
        void drain(id, fresh, task);
      }
    },
  };
}
