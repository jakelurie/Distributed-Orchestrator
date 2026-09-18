import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile('server/public/app.js', 'utf8');
const hosts = [
  { id: 'laptop', name: 'Laptop', number: 1, active: true },
  { id: 'desktop', name: 'Desktop', number: 2, active: true },
];
const list = {};
const context = { list, data: { hosts, self: 'laptop', leader: 'desktop' }, esc: String, seen: () => 'today' };
vm.createContext(context);
const render = source.slice(source.indexOf('    list.innerHTML = data.hosts.map('), source.indexOf("    list.querySelectorAll('[data-prefer]')"));
vm.runInContext(render, context);
assert.match(list.innerHTML, /Laptop<\/div>\s*<div class="s">active · replica/);
assert.match(list.innerHTML, /Desktop<\/div>\s*<div class="s">active · main/);
assert.doesNotMatch(list.innerHTML, /this host/);
context.data.leader = 'laptop';
vm.runInContext(render, context);
assert.match(list.innerHTML, /Laptop<\/div>\s*<div class="s">active · main/);
assert.match(list.innerHTML, /Desktop<\/div>\s*<div class="s">active · replica/);
const tailnet = {};
context.$ = () => tailnet;
context.inventory = { devices: [{ name: 'Laptop', local: true, active: true, platform: 'macOS' }] };
vm.runInContext(source.slice(source.indexOf("    $('tailnet-list').innerHTML = inventory.devices.map("), source.indexOf('    if (inventory.error)')), context);
assert.match(tailnet.innerHTML, /Laptop<\/div>/);
assert.doesNotMatch(tailnet.innerHTML, /this device/);
console.log('PASS machine labels track the primary independently of the serving host');

assert.match(list.innerHTML, /🖥 1/);
assert.match(list.innerHTML, /🖥 2/);
