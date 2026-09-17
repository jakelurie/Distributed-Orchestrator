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

// Exercise the real toggle handler with unsaved SMS fields and API validation.
async function smsForm({ savedPassword = false, failSave = false } = {}) {
  const controls = new Map();
  const on = { dataset: { notify: 'on' } };
  const off = { dataset: { notify: 'off' } };
  const box = { innerHTML: '', querySelectorAll: (selector) => selector === '[data-notify]' ? [off, on] : [] };
  controls.set('s-notify', box);
  for (const id of ['notify-status', 'n-save', 'n-test', 'n-to', 'n-guser', 'n-gpass', 'n-carrier']) controls.set(id, { value: '' });
  const cfg = { kind: 'sms', enabled: false, hasGmailPass: savedPassword };
  const calls = [];
  const ctx = { $: (id) => controls.get(id), esc: (s) => String(s), api: async (url, options) => {
    if (!options) return cfg;
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url === '/api/email') {
      if (failSave) throw new Error('Could not save credentials');
      cfg.gmailUser = body.gmailUser;
      cfg.hasGmailPass ||= Boolean(body.gmailPass);
    } else {
      if (body.enabled && (!cfg.gmailUser || !cfg.hasGmailPass)) throw new Error('SMS setup incomplete');
      Object.assign(cfg, body);
    }
  } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('async function paintNotify()'), source.indexOf('/**\n * Git panel')), ctx);
  await ctx.paintNotify();
  controls.get('n-to').value = '8045551234';
  controls.get('n-guser').value = 'sender@example.com';
  controls.get('n-gpass').value = savedPassword ? '' : 'test-app-password';
  controls.get('n-carrier').value = 'att';
  return { controls, cfg, calls, on, off };
}
let form = await smsForm();
await form.on.onclick();
assert.equal(form.cfg.enabled, true);
assert.equal(form.cfg.to, '8045551234');
assert.deepEqual(form.calls.map((c) => c.url), ['/api/email', '/api/notify']);
assert.equal(form.calls[0].body.carrier, 'att');
assert.equal(form.calls[0].body.gmailPass, 'test-app-password');
assert.equal(form.on.disabled, false);
assert.match(form.controls.get('notify-status').textContent, /enabled/);
form = await smsForm({ savedPassword: true });
await form.on.onclick();
assert.equal(form.cfg.enabled, true);
assert.equal('gmailPass' in form.calls[0].body, false);
form = await smsForm({ failSave: true });
await form.on.onclick();
assert.equal(form.cfg.enabled, false);
assert.equal(form.calls.length, 1);
assert.equal(form.on.disabled, false);
assert.equal(form.controls.get('n-gpass').value, 'test-app-password');
assert.match(form.controls.get('notify-status').textContent, /Could not enable: Could not save credentials/);
await form.off.onclick();
assert.equal(form.calls.at(-1).url, '/api/notify');
assert.deepEqual(form.calls.at(-1).body, { enabled: false });
console.log('PASS SMS enables after saving entered fields, preserves saved passwords, reports failures, and disables without credentials');
