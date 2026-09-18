// The project sheet's Machines checklist: shown once a second machine joins,
// defaulting new projects to the main, and reporting each copy's state.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../server/public/app.js', import.meta.url), 'utf8');
assert.match(source, /<div id="ap-machines"><\/div>/);
assert.match(source, /if \(hosts\) body\.hosts = hosts\(\);/);
const start = source.indexOf('async function paintAppMachines');
const end = source.indexOf('\n}\n', start) + 3;

function sheet(status) {
  const box = { isConnected: true, innerHTML: '', querySelectorAll: () => [] };
  const paint = vm.runInNewContext(source.slice(start, end) + '\npaintAppMachines;', {
    $: () => box, esc: String, api: async () => status,
  });
  return { box, paint };
}
const hosts = [{ id: 'A', name: 'laptop', member: true, active: true }, { id: 'B', name: 'desktop', member: true, active: false }];

let { box, paint } = sheet({ leader: 'A', hosts: [hosts[0]] });
assert.equal(await paint(null), null);
assert.equal(box.innerHTML, '');

({ box, paint } = sheet({ leader: 'A', hosts }));
assert.equal(typeof await paint(null), 'function');
assert.match(box.innerHTML, /data-host="A" checked disabled/);
assert.match(box.innerHTML, /data-host="B"  \/>/);
assert.match(box.innerHTML, /laptop · main/);
assert.match(box.innerHTML, /desktop · offline/);

({ box, paint } = sheet({ leader: 'A', hosts }));
await paint({ ownerNode: 'B', machines: [{ id: 'A', placed: false }, { id: 'B', placed: true, state: 'kept', error: 'kept on this machine because it has stashed changes' }] });
assert.match(box.innerHTML, /data-host="A"  \/>/);
assert.match(box.innerHTML, /data-host="B" checked disabled/);
assert.match(box.innerHTML, /stashed changes/);
console.log('PASS the project sheet lists machines, defaults to the main, and shows copy state');

assert.match(box.innerHTML, /Hosted on desktop/);
assert.match(box.innerHTML, /replicate here/);
assert.doesNotMatch(source, /computerBadge|data-takeover|s-computers/);
