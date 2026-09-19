import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile('server/public/app.js', 'utf8');
const nodes = new Map();
const $ = id => { if (!nodes.has(id)) nodes.set(id, { querySelectorAll: () => [] }); return nodes.get(id); };
let html = '';
const context = { $, state: { session: { id: 'one', appId: 'app' }, machines: { hosts: [{ id: 'b', name: 'Desktop' }] },
  projectQueues: { 'turn-queue:app': [{ id: 'turn', number: 7, sessionId: 'one', name: 'Tab <one>', owner: 'b', state: 'blocked', detail: 'conflict' }] } },
  refreshState: async () => {}, esc: x => String(x).replaceAll('<', '&lt;'), openSheet: value => { html = value; }, closeSheet() {},
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('async function projectQueueSheet()'), source.indexOf('function showSession()')), context);
await context.projectQueueSheet();
assert.match(html, /#7 · Tab &lt;one>/);
assert.match(html, /blocked · Desktop/);
assert.match(html, /data-skip-turn="turn"/);
assert.match(html, /conflict/);
assert.match(html, /Failed or offline turns do not hold other tabs/);
assert.doesNotMatch(source, /waiting for turn #/);
assert.match(source, /integrating turn #/);
assert.match(html, /data-retry-turn="one"/);
assert.doesNotMatch(source, /confirm\('Also put the project files back/);
assert.match(source, /turn\.user\.turnNumber \?\? number/);
console.log('PASS shared queue rendering, slot numbers, owner, blocked state and removal of file rewind');
