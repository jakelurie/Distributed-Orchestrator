import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile('server/public/app.js', 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function modelVersionDetails('), source.indexOf('async function sessionSettingsSheet()')), context);
const details = context.modelVersionDetails;
const model = { alias: 'opus', provider: 'claude-cli', model: 'opus[1m]' };
assert.match(details(model), /Automatic model alias.*version unconfirmed.*1 million token context/);
const events = [
  { type: 'assistant', model: 'opus', servedModel: 'claude-opus-5' },
  { type: 'assistant', model: 'other', servedModel: 'different-model' },
  { type: 'assistant', model: 'opus', servedModel: 'claude-opus-5-5' },
];
assert.match(details(model, events), /Last reply used: claude-opus-5-5/);
assert.doesNotMatch(details(model, events), /unconfirmed|different-model/);
assert.match(details(model, [...events, { type: 'assistant', model: 'opus' }]), /version unconfirmed/);
assert.equal(details({ ...model, model: 'claude-opus-5-5' }), '');
assert.equal(details({ ...model, provider: 'openai', model: 'opus' }), '');
assert.match(source, /esc\(modelVersionDetails\(m, session.events\)\)/);
assert.match(source, /esc\(modelVersionDetails\(m\)\)/);
console.log('PASS model version details distinguish observed versions, aliases, context and unconfirmed replies');
