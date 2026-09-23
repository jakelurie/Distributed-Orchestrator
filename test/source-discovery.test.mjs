import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { codexModels, claudeModels } from '../src/core/source-discovery.js';
function mockCodex(account = { type: 'chatgpt' }) {
  const calls = []; let killed = false;
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { killed = true; };
    child.stdin.on('data', data => {
      const message = JSON.parse(String(data)); calls.push(message);
      if (!message.id) return;
      const result = message.method === 'initialize' ? {} : message.method === 'account/read' ? { account }
        : message.params.cursor ? { data: [{ model: 'second', displayName: 'Second' }], nextCursor: null }
        : { data: [{ model: 'first', displayName: 'First' }, { model: 'hidden', hidden: true }], nextCursor: 'next' };
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n'));
    });
    return child;
  };
  return { spawnProcess, calls, killed: () => killed };
}
const mock = mockCodex();
assert.deepEqual(await codexModels({ spawnProcess: mock.spawnProcess, env: {} }), [
  { model: 'first', label: 'First' }, { model: 'second', label: 'Second' },
]);
assert.equal(mock.killed(), true);
assert.ok(mock.calls.every(m => !m.method.includes('turn')));
const unsigned = mockCodex(null);
await assert.rejects(codexModels({ spawnProcess: unsigned.spawnProcess, env: {} }), /Sign in/);
assert.equal(unsigned.killed(), true);
let closed = false;
const result = await claudeModels({ env: {}, run: async () => '{"loggedIn":true}', load: async () => ({
  query: options => {
    assert.deepEqual(options.options.tools, []);
    return { supportedModels: async () => [{ value: 'sonnet', displayName: 'Sonnet' }], close: () => { closed = true; } };
  },
}) });
assert.deepEqual(result, [{ model: 'sonnet', label: 'Sonnet' }]);
assert.equal(closed, true);
await assert.rejects(claudeModels({ env: {}, run: async () => '{"loggedIn":false}' }), /Sign in/);
console.log('PASS authenticated discovery, Codex paging, hidden model filtering, no inference, and process cleanup');
