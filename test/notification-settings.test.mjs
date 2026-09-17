import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile('server/public/app.js', 'utf8');
const nodes = new Map();
const $ = (id) => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); };
let rendered;
let emailPaints = 0;
let textPaints = 0;
const context = { $, openSheet: (html) => { rendered = html; },
  backToSettings: '<button id="sub-back">settings</button>', settingsSheet() {},
  paintEmail: () => emailPaints++, paintNotify: () => textPaints++ };
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function notifySheet()'), source.indexOf('/**\n * Switch the open session')), context);
context.notifySheet();
assert.match(rendered, /<h2>Notifications<\/h2>/);
assert.match(rendered, /id="h-email"><span>Email/);
assert.match(rendered, /id="h-text"><span>Text/);
$('h-email').onclick();
assert.match(rendered, /<h2>Email<\/h2>/);
assert.equal(emailPaints, 1);
$('sub-back').onclick();
assert.match(rendered, /<h2>Notifications<\/h2>/);
$('h-text').onclick();
assert.match(rendered, /<h2>Text<\/h2>/);
assert.match(rendered, /id="notify-status"/);
assert.equal(textPaints, 1);
$('sub-back').onclick();
assert.match(rendered, /<h2>Notifications<\/h2>/);
const settings = source.slice(source.indexOf('async function settingsSheet()'), source.indexOf('async function githubSheet()'));
assert.doesNotMatch(settings, /h-email/);
assert.match(settings, /h-notify/);
console.log('PASS Notifications groups Email and Text with working navigation');
