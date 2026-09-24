import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile('server/public/app.js', 'utf8');
const nodes = new Map();
const $ = id => {
  if (!nodes.has(id)) nodes.set(id, { value: '', querySelectorAll: () => [] });
  return nodes.get(id);
};
let html = '', pending = [];
const machines = { self: 'laptop', hosts: [{ id: 'laptop', name: 'Laptop', member: true }, { id: 'desktop', name: 'Desktop', member: true }] };
const context = { $, esc: String, backToSettings: '', settingsSheet() {}, sourceSheet() {}, onboardSource() {},
  openSheet: value => { html = value; }, nativeFetch: async (url, options) => {
    if (url.endsWith('/status')) return { json: async () => machines };
    const body = JSON.parse(options.body);
    return new Promise(resolve => pending.push({ host: body.host, resolve: catalog => resolve({ ok: true, json: async () => catalog }) }));
  },
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function modelVersionDetails('), source.indexOf('async function sessionSettingsSheet()')), context);
vm.runInContext(source.slice(source.indexOf('const sourceAttr ='), source.indexOf('function onboardSource(')), context);
const catalog = (host, models) => ({ machine: { id: host, name: host }, models, jobs: [] });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const first = context.modelsSheet(); await flush();
pending.shift().resolve(catalog('laptop', { q: { alias: 'q', model: 'qwen', provider: 'openai' }, c: { alias: 'c', model: 'claude', provider: 'claude-cli' } }));
await first;
assert.match(html, /qwen/);
assert.match(html, /Manage Claude Code/);
assert.doesNotMatch(html, /Set up Claude Code/);
$('sources-host').value = 'desktop';
$('sources-host').onchange();
assert.doesNotMatch(html, /qwen/, 'old rows clear immediately');
await flush();
pending.shift().resolve(catalog('desktop', { c: { alias: 'c', model: 'codex', provider: 'codex-cli' } }));
await flush();
assert.doesNotMatch(html, /qwen/);
assert.match(html, /Manage Codex/);
assert.match(html, /Set up Claude Code/);
// A slow old response must never overwrite the current selection.
const old = context.modelsSheet(); await flush();
vm.runInContext("sourceHost = 'laptop'", context);
const newer = context.modelsSheet(); await flush();
const slow = pending.shift(), fast = pending.shift();
fast.resolve(catalog('laptop', {})); await newer;
slow.resolve(catalog('desktop', { q: { model: 'wrong-model' } })); await old;
assert.doesNotMatch(html, /wrong-model/);
const mismatched = context.modelsSheet(); await flush();
pending.shift().resolve(catalog('desktop', {})); await mismatched;
assert.match(html, /another computer/);
console.log('PASS machine-specific rows, configured controls, stale response protection and host validation');
