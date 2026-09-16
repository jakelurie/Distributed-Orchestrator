import assert from 'node:assert/strict';
import { deleteAppRepo, githubRepoIdentity } from '../src/core/git.js';
const app = { dir: '/unused', repo: 'git@github.com:owner/XManager.git' };
const calls = [];
const execute = async (bin, args) => { calls.push([bin, ...args]); return { stdout: '' }; };
assert.equal(githubRepoIdentity('https://github.com/owner/XManager.git'), 'owner/XManager');
for (const confirmation of [undefined, '', 'XManager', 'owner/other']) {
  await assert.rejects(deleteAppRepo(app, confirmation, execute), /Confirm/);
}
await assert.rejects(deleteAppRepo({ ...app, builtin: true }, 'owner/XManager', execute), /built-in/);
await assert.rejects(deleteAppRepo({ ...app, repo: 'https://example.org/owner/XManager' }, 'owner/XManager', execute), /Confirm/);
assert.equal(calls.length, 0);
assert.equal(await deleteAppRepo(app, 'owner/XManager', execute), 'owner/XManager');
assert.deepEqual(calls, [['gh', 'repo', 'delete', 'owner/XManager', '--yes']]);
await assert.rejects(deleteAppRepo(app, 'owner/XManager', async () => { throw new Error('GitHub denied'); }), /GitHub denied/);
console.log('PASS GitHub deletion requires exact repository confirmation and preserves errors; no live repositories deleted');
