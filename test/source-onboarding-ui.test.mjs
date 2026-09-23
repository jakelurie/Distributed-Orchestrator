import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile('server/public/app.js', 'utf8');
const nodes = new Map();
const $ = id => {
  if (!nodes.has(id)) nodes.set(id, { value: '', dataset: {}, querySelectorAll: () => [] });
  return nodes.get(id);
};
let html, calls = [];
const context = { $, esc: s => String(s), sourceAttr: s => String(s).replaceAll('"', '&quot;'),
  openSheet: value => { html = value; }, modelsSheet: async () => {},
  sourcesCall: async (action, args) => { calls.push({ action, args }); return action === 'discover'
    ? { models: [{ model: 'local:"test', label: 'Local', tools: false }], message: 'found' } : {}; },
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function onboardSource('), source.indexOf('function sourceSheet()')), context);
context.onboardSource('codex-cli');
assert.match(html, /codex login/);
assert.match(html, /check login &amp; discover/);
context.onboardSource('ollama');
assert.match(html, /download model/);
assert.match(html, /Allow paired agents/);
await $('source-discover').onclick();
assert.match($('source-discovered').innerHTML, /local:&quot;test/);
assert.match($('source-discovered').innerHTML, /chat only/);
$('sheet').querySelectorAll = () => [{ dataset: { discoveredModel: 'local:test' } }];
$('source-delegate').checked = true;
await $('onboard-add').onclick();
assert.equal(calls.at(-1).action, 'add');
assert.equal(calls.at(-1).args.allowDelegate, true);
assert.deepEqual(Array.from(calls.at(-1).args.models), ['local:test']);
console.log('PASS guided source flows, escaped discovery, model selection and helper consent');
