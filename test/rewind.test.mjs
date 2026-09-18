// Removing a message from the context, and winding a conversation back —
// including putting the project files back without losing the history.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { eraseEvent, rewindTo, commitShaAt } from '../src/core/rewind.js';
import { noteEvent, toAnthropic, danglingToolCalls } from '../src/core/transcript.js';
import { restoreTo } from '../src/core/git.js';

// ------------------------------------------------------------ the transcript

const events = [
  { id: 'u1', type: 'user', text: 'first question' },
  { id: 'a1', type: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'shell', args: {} }] },
  { id: 't1', type: 'tool_result', callId: 'c1', name: 'shell', ok: true, output: 'done' },
  { id: 'a2', type: 'assistant', text: 'first answer', toolCalls: [] },
  { id: 'n1', type: 'note', text: 'git: integrated and pushed 2 files · abc1234', sha: 'abc1234' },
  { id: 'u2', type: 'user', text: 'second question' },
  { id: 'a3', type: 'assistant', text: 'second answer', toolCalls: [] },
];

const erasedTurn = eraseEvent(events, 'u1');
assert.deepEqual(erasedTurn.events.map((e) => e.id), ['n1', 'u2', 'a3']);
assert.match(erasedTurn.describe, /your messages/);
console.log('PASS deleting a question takes its work with it, and keeps the commit note');

const erasedReply = eraseEvent(events, 'a1');
assert.deepEqual(erasedReply.events.map((e) => e.id), ['u1', 'a2', 'n1', 'u2', 'a3']);
assert.equal(danglingToolCalls(erasedReply.events).length, 0);
console.log('PASS deleting a reply takes the results of its tool calls with it');

const erasedResult = eraseEvent(events, 't1');
assert.deepEqual(erasedResult.events.map((e) => e.id), ['u1', 'a2', 'n1', 'u2', 'a3']);
assert.equal(danglingToolCalls(erasedResult.events).length, 0);
console.log('PASS deleting a tool result removes the call that would be left unanswered');

// The whole point: it is gone from what the provider is sent, not merely hidden.
const wire = toAnthropic(eraseEvent(events, 'u1').events);
assert.ok(!JSON.stringify(wire).includes('first question'));
assert.ok(JSON.stringify(wire).includes('second question'));
assert.throws(() => eraseEvent(events, 'nope'), /no longer in this conversation/);
console.log('PASS an erased message is no longer rendered into a provider request');

const wound = rewindTo(events, 'u2');
assert.deepEqual(wound.events.map((e) => e.id), ['u1', 'a1', 't1', 'a2', 'n1']);
assert.equal(wound.draft, 'second question');
assert.equal(wound.removed, 2);
console.log('PASS rewinding drops the message and everything after it, returning it as a draft');

assert.equal(commitShaAt(events, 'u2'), 'abc1234');
assert.equal(commitShaAt(events, 'u1'), null);
assert.equal(commitShaAt([noteEvent('git: integrated locally 1 file · deadbee'), { id: 'u9', type: 'user' }], 'u9'), 'deadbee');
console.log('PASS the commit for a point in the conversation is found, including in older sessions');

// ------------------------------------------------------------------- the git

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-rewind-'));
git(['init', '-b', 'main'], repo);
git(['config', 'user.email', 'test@example.com'], repo);
git(['config', 'user.name', 'Test'], repo);

await fs.writeFile(path.join(repo, 'keep.txt'), 'original');
git(['add', '-A'], repo);
git(['commit', '-m', 'one'], repo);
const first = git(['rev-parse', 'HEAD'], repo);

await fs.writeFile(path.join(repo, 'keep.txt'), 'changed');
await fs.writeFile(path.join(repo, 'added.txt'), 'new work');
git(['add', '-A'], repo);
git(['commit', '-m', 'two'], repo);

const back = await restoreTo(repo, first);
assert.ok(back.ok && back.restored, JSON.stringify(back));
assert.equal(await fs.readFile(path.join(repo, 'keep.txt'), 'utf8'), 'original');
assert.equal(await fs.stat(path.join(repo, 'added.txt')).catch(() => null), null);
assert.equal(git(['status', '--porcelain'], repo), '');
console.log('PASS restoring puts edited and added files back the way they were');

// The undone work must still be reachable: this is a new commit, not a reset.
assert.equal(git(['log', '--oneline'], repo).split('\n').length, 3);
assert.ok(git(['log', '--format=%s'], repo).includes('two'));
assert.equal(git(['show', '-s', '--format=%s', 'HEAD'], repo), `harness: restore project to ${first.slice(0, 8)}`);
console.log('PASS the restore is a new commit and the discarded version stays in the history');

assert.equal((await restoreTo(repo, first)).skipped, 'the files are already in that state');
await fs.writeFile(path.join(repo, 'keep.txt'), 'uncommitted edit');
assert.match((await restoreTo(repo, first)).error, /uncommitted changes/);
git(['checkout', '--', 'keep.txt'], repo);
assert.match((await restoreTo(repo, 'f'.repeat(40))).error, /not in this repository/);
console.log('PASS restoring is refused on a dirty tree or an unknown commit');

// -------------------------------------------------------------------- the UI

const source = await fs.readFile('server/public/app.js', 'utf8');
const context = { esc: String, render: String, compact: String, clock: () => '', copyTexts: new Map(), toolBlock: () => '' };
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function activityChip('), source.indexOf('function drawTranscript(')), context);
const html = context.turnHtml({
  user: { id: 'u1', text: 'question' },
  texts: [{ id: 'a1', text: 'answer', model: 'm' }],
  steps: [], notes: [], files: [], endedOn: 'reply',
}, 0, false, 1, true);
assert.match(html, /data-rewind="u1"/);
assert.match(html, /data-erase="u1"/);
assert.match(html, /data-erase="a1"/);
// Rewinding a reply is meaningless: you go back to what you asked, not to what
// it said.
assert.doesNotMatch(html, /data-rewind="a1"/);
console.log('PASS every message offers delete, and your own messages also offer rewind');

assert.match(source, /sessions\/\$\{id\}\/\$\{verb\}/);
assert.match(source, /data-erase/);
const css = await fs.readFile('server/public/styles.css', 'utf8');
const act = css.match(/\.msg-act \{([^}]+)\}/)[1];
assert.match(act, /var\(--bg-3\)/);
assert.match(act, /var\(--fg-dim\)/);
assert.doesNotMatch(act, /#[0-9a-fA-F]{3,6}/);
console.log('PASS the controls use the existing pill style and theme variables');

const server = await fs.readFile('server/index.js', 'utf8');
assert.match(server, /\['erase', 'rewind'\]\.includes\(verb\)/);
assert.match(server, /Stop the turn and wait for it to finish before editing this conversation/);
assert.match(server, /\{ sha: res\.sha \}/);
console.log('PASS the routes exist, refuse mid-turn, and record the commit for later rewinds');
