import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile(new URL('../server/public/app.js', import.meta.url), 'utf8');
let paste;
const uploaded = [];
vm.runInNewContext(source.slice(source.indexOf("$('input').addEventListener('paste'"), source.indexOf("$('send').onclick")), {
  $: () => ({ addEventListener: (name, fn) => { paste = fn; } }),
  attachFiles: (files) => uploaded.push(files),
});
let prevented = 0;
const file = { name: 'clipboard.png', type: 'image/png' };
const event = (data) => ({ clipboardData: data, preventDefault: () => prevented++ });
paste(event({ files: [file], items: [{ kind: 'file', getAsFile: () => file }] }));
assert.equal(uploaded[0].length, 1);
assert.equal(uploaded[0][0], file);
paste(event({ items: [{ kind: 'file', getAsFile: () => file }] }));
assert.equal(uploaded[1][0], file);
paste(event({ files: [], items: [{ kind: 'string' }] }));
paste(event(null));
assert.equal(uploaded.length, 2);
assert.equal(prevented, 2);
console.log('PASS clipboard files, item fallback, no duplicates, and native text paste');
