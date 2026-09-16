import assert from 'node:assert/strict';
import { defaultRepoName, renameAppRepo } from '../src/core/git.js';
assert.equal(defaultRepoName('/projects/getjobs', 'GetJobs'), 'GetJobs');
assert.equal(defaultRepoName('/projects/newentertainment', 'NewEntertainment'), 'NewEntertainment');
assert.equal(defaultRepoName('/projects/fallback'), 'fallback');
assert.equal(defaultRepoName('/projects/app', 'My App / Research'), 'My-App-Research');
assert.equal(defaultRepoName('/projects/app', '!!!'), 'project');
console.log('PASS repository names preserve app capitalization and sanitize unsupported characters');

const app = { dir: '/unused', repo: 'git@github.com:owner/old.git' };
const calls = [];
const execute = async (bin, args) => {
  calls.push([bin, ...args]);
  return { stdout: args.includes('get-url') ? app.repo : '{}' };
};
assert.equal(await renameAppRepo(app, 'New Name', execute), 'git@github.com:owner/New-Name.git');
assert.deepEqual(calls[1], ['gh', 'api', '--method', 'PATCH', 'repos/owner/old', '-f', 'name=New-Name']);
assert.deepEqual(calls[2], ['git', 'remote', 'set-url', 'origin', 'git@github.com:owner/New-Name.git']);
const failed = [];
await assert.rejects(renameAppRepo(app, 'Taken', async (bin, args) => {
  failed.push(bin);
  if (bin === 'gh') throw new Error('name already exists');
  return { stdout: app.repo };
}), /name already exists/);
assert.deepEqual(failed, ['git', 'gh']);
assert.equal(await renameAppRepo({ dir: '/unused' }, 'Workspace', async () => { throw new Error('no origin'); }), null);
console.log('PASS linked repo rename, origin update, rejection, and workspace without a repo');

// Saving an unchanged app name repairs an old mismatched link too.
const fs = await import('node:fs/promises');
const vm = await import('node:vm');
const appSource = await fs.readFile(new URL('../src/core/apps.js', import.meta.url), 'utf8');
const updateSource = appSource.slice(appSource.indexOf('export async function update('),
  appSource.indexOf('export async function remove(')).replace('export ', '');
const savedApp = { id: 'x', name: 'XManager', repo: 'git@github.com:owner/TwitterManager.git' };
let renamedTo;
const update = vm.runInNewContext(updateSource + '\nupdate;', {
  load: async () => [savedApp],
  renameAppRepo: async (a, name) => { renamedTo = name; return 'git@github.com:owner/' + name + '.git'; },
  persist: async () => {},
});
await update('/unused', 'x', { name: 'XManager' });
assert.equal(renamedTo, 'XManager');
assert.equal(savedApp.repo, 'git@github.com:owner/XManager.git');
console.log('PASS saving the app name repairs an existing repository mismatch');
