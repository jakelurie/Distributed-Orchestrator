import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../server/public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('  if (turn.files.length) {');
const end = source.indexOf('\n  const sum = foldSummary', start);
function render(files) {
  const context = { turn: { files }, bits: [], esc: String, humanSize: String,
    FILE_ICON: {}, encodeURIComponent };
  vm.runInNewContext(source.slice(start, end), context);
  return context.bits.join('');
}
assert.equal(render([]), '');
const file = { path: '/test.txt', name: 'test.txt', kind: 'text', size: 42 };
const html = render([file, file]);
assert.match(html, /<details class="turn-files"><summary>Files \(1\)<\/summary>/);
assert.ok(!/<details[^>]*\sopen(?:\s|>)/.test(html));
assert.match(html, /data-open-file="\/test.txt"/);
assert.match(html, /download="test.txt"/);
assert.match(html, /<\/div><\/details>$/);
console.log('PASS file groups default collapsed, count unique files, preserve preview and download');
