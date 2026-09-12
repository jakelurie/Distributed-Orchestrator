import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addModel } from '../src/core/config.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sources-'));
try {
  const original = { default: 'mine', models: { mine: { provider: 'codex-cli', model: 'existing' } } };
  await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify(original));
  await fs.writeFile(path.join(dir, 'secrets.json'), '{"mine":"untouched"}');
  const first = await addModel(dir, { label: 'Kimi', provider: 'openai', model: 'account-model', baseUrl: 'https://api.moonshot.ai/v1', apiKeyEnv: 'MOONSHOT_API_KEY' });
  const second = await addModel(dir, { label: 'Kimi', provider: 'codex-cli', model: 'another-model' });
  assert.notEqual(first, second);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'models.json')));
  assert.deepEqual(saved.models.mine, original.models.mine);
  assert.equal(saved.default, 'mine');
  assert.equal(saved.models[first].apiKeyEnv, 'MOONSHOT_API_KEY');
  assert.equal(await fs.readFile(path.join(dir, 'secrets.json'), 'utf8'), '{"mine":"untouched"}');
  for (const patch of [{ provider: 'bad' }, { model: '' }, { label: '' }, { baseUrl: 'file:///tmp' }]) {
    await assert.rejects(addModel(dir, { label: 'test', provider: 'openai', model: 'test', ...patch }));
  }
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'models.json'))), saved);
  console.log('PASS new AI sources preserve existing models, defaults and keys; invalid entries are rejected');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}

// Exercise the setup form and its submitted payload without real credentials.
const { default: vm } = await import('node:vm');
const source = await fs.readFile(new URL('../server/public/app.js', import.meta.url), 'utf8');
const elements = {};
const get = (id) => elements[id] ??= { value: '', hidden: false };
get('source-kind').value = '0';
let submitted;
let html;
const context = {
  $: get, openSheet: (value) => { html = value; }, modelsSheet: async () => {},
  showBanner: () => {}, api: async (url, options) => { submitted = JSON.parse(options.body); },
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function sourceSheet()'), source.indexOf('function notifySheet()')) + '\nsourceSheet();', context);
assert.match(html, /Kimi.*Moonshot/);
assert.equal(get('source-api').hidden, true);
get('source-kind').value = '4';
get('source-kind').onchange();
assert.equal(get('source-api').hidden, false);
assert.equal(get('source-url').value, 'https://api.moonshot.ai/v1');
get('source-model').value = 'my-model';
get('source-key').value = 'dummy';
await get('source-save').onclick();
assert.equal(submitted.provider, 'openai');
assert.equal(submitted.apiKeyEnv, 'MOONSHOT_API_KEY');
get('source-kind').value = '1';
get('source-kind').onchange();
await get('source-save').onclick();
assert.equal(submitted.provider, 'codex-cli');
assert.equal(submitted.apiKey, '');
assert.equal(submitted.baseUrl, '');
console.log('PASS API and subscription setup submit separate credential paths');
