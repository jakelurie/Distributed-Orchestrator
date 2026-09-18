import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile('server/public/app.js', 'utf8');
const hosts = [
  { id: 'laptop', name: 'Laptop', number: 1, active: true },
  { id: 'desktop', name: 'Desktop', number: 2, active: false, url: 'https://desktop.example.ts.net:8443' },
];
const list = {};
const context = { list, data: { hosts, self: 'laptop', leader: 'desktop' }, URL, esc: String, seen: () => 'today' };
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function machineAddressLink('), source.indexOf('async function machinesSheet()')), context);
const render = source.slice(source.indexOf('    list.innerHTML = data.hosts.map('), source.indexOf("    list.querySelectorAll('[data-prefer]')"));
vm.runInContext(render, context);
assert.match(list.innerHTML, /Laptop<\/div>\s*<div class="s">active · replica/);
assert.match(list.innerHTML, /Desktop<\/div>\s*<div class="s">offline · main/);
assert.doesNotMatch(list.innerHTML, /this host/);
context.data.leader = 'laptop';
vm.runInContext(render, context);
assert.match(list.innerHTML, /Laptop<\/div>\s*<div class="s">active · main/);
assert.match(list.innerHTML, /Desktop<\/div>\s*<div class="s">offline · replica/);
const tailnet = {};
context.$ = () => tailnet;
context.inventory = { devices: [{ name: 'Laptop', local: true, active: true, platform: 'macOS' }] };
vm.runInContext(source.slice(source.indexOf("    $('tailnet-list').innerHTML = inventory.devices.map("), source.indexOf('    if (inventory.error)')), context);
assert.match(tailnet.innerHTML, /Laptop<\/div>/);
assert.doesNotMatch(tailnet.innerHTML, /this device/);
console.log('PASS machine labels track the primary independently of the serving host');

assert.match(list.innerHTML, /🖥 1/);
assert.match(list.innerHTML, /🖥 2/);

assert.match(list.innerHTML, /href="https:\/\/desktop.example.ts.net:8443"/);
assert.match(list.innerHTML, /Address not configured/);
assert.match(list.innerHTML, /rel="noopener noreferrer"/);
assert.doesNotMatch(context.machineAddressLink('javascript:alert(1)'), /href=/);
assert.doesNotMatch(context.machineAddressLink('https://user:secret@example.com'), /href=/);
assert.match(context.machineAddressLink('http://100.64.0.2:8787'), /http:\/\/100.64.0.2:8787/);
