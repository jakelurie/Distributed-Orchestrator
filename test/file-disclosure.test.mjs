import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../server/public/app.js', import.meta.url), 'utf8');
const context = { esc: String, render: String, compact: String, clock: () => '',
  humanSize: String, copyTexts: new Map(), toolBlock: () => '' };
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function activityChip('), source.indexOf('function drawTranscript(')), context);
const turn = {
  user: { id: 'u', text: 'QUESTION', attachments: [{ role: 'document', path: '/input.pdf', name: 'input.pdf', mime: 'application/pdf' }] },
  texts: [{ text: '[Download result](/result.txt)', model: 'm' }],
  steps: [], notes: [], files: [{ path: '/result.txt', name: 'result.txt', kind: 'text', size: 42 }], endedOn: 'reply',
};
const html = context.turnHtml(turn, 0, false, 1, true);
assert.doesNotMatch(html, /turn-files|<summary>Files|data-open-file="\/result.txt"/);
assert.match(html, /final-reply/);
assert.match(html, /\[Download result\]\(\/result.txt\)/);
assert.match(html, /data-open-file="\/input.pdf"/);
assert.match(html, /QUESTION/);
console.log('PASS generated Files section omitted; reply links and input attachments retained');
