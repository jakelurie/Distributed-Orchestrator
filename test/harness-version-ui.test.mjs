import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile('server/public/app.js', 'utf8');
const nodes = new Map();
const $ = id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); };
let html, restarted;
const context = { $, openSheet: value => { html = value; }, closeSheet() {}, showBanner() {},
  settingsSheet() {}, esc: value => String(value).replaceAll('<', '&lt;'),
  restartOrchestrator: button => { restarted = button; },
  api: async () => ({ aligned: false, checkedAt: '2026-09-23T12:00:00Z', hosts: [
    { name: '<Laptop>', state: 'Restart needed', version: { revision: 'abcdef123456789', committedAt: '2026-09-22T12:00:00Z', startedAt: '2026-09-23T11:00:00Z' }, update: { head: 'newcommit123456789' } },
    { name: 'Desktop', state: 'Unreachable — version unverified' },
  ] }),
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('async function harnessVersionSheet()'), source.indexOf('async function githubSheet()')), context);
await context.harnessVersionSheet();
assert.match(html, /Restart needed/);
assert.match(html, /Unreachable — version unverified/);
assert.match(html, /Running abcdef123456/);
assert.match(html, /Downloaded newcommit123/);
assert.match(html, /committed/);
assert.match(html, /Started/);
assert.match(html, /&lt;Laptop>/);
assert.doesNotMatch(html, /All paired machines run the same/);
const button = {};
$('version-restart').onclick({ currentTarget: button });
assert.equal(restarted, button);
console.log('PASS version sheet timestamps, downloaded versus running revision, unverified peers and restart control');
