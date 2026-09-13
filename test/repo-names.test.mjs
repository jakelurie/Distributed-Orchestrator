import assert from 'node:assert/strict';
import { defaultRepoName } from '../src/core/git.js';
assert.equal(defaultRepoName('/projects/getjobs', 'GetJobs'), 'GetJobs');
assert.equal(defaultRepoName('/projects/newentertainment', 'NewEntertainment'), 'NewEntertainment');
assert.equal(defaultRepoName('/projects/fallback'), 'fallback');
assert.equal(defaultRepoName('/projects/app', 'My App / Research'), 'My-App-Research');
assert.equal(defaultRepoName('/projects/app', '!!!'), 'project');
console.log('PASS repository names preserve app capitalization and sanitize unsupported characters');
