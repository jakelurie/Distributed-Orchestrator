import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAISources } from '../src/core/ai-sources.js';
import { loadConfig } from '../src/core/config.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sources-onboarding-'));
const requests = [];
const request = async (url, opts) => {
  const body = opts.body && JSON.parse(opts.body);
  requests.push({ url, body });
  const result = url.endsWith('/api/tags') ? { models: [{ name: 'local:test' }, { name: 'embed:test' }] }
    : url.endsWith('/api/show') ? { capabilities: body.model === 'embed:test' ? ['embedding'] : ['completion', 'tools'] }
    : url.endsWith('/api/chat') ? { message: { content: 'helper answer' }, prompt_eval_count: 4, eval_count: 2 } : {};
  return { ok: true, json: async () => result };
};
try {
  assert.deepEqual((await loadConfig(dir)).models, {});
  assert.equal((await loadConfig(dir)).error, null);
  const sources = createAISources(dir, { request, discoverCodex: async () => [{ model: 'test-codex', label: 'Codex test' }],
    discoverClaude: async () => { throw Error('Sign in first'); } });
  await assert.rejects(sources.add({ kind: 'codex-cli', models: ['invented'] }), /Refresh/);
  await assert.rejects(sources.discover('claude-cli'), /Sign in/);
  await sources.discover('codex-cli');
  await assert.rejects(sources.add({ kind: 'codex-cli', models: ['invented'] }), /not reported/);
  const { aliases } = await sources.add({ kind: 'codex-cli', models: ['test-codex'] });
  assert.deepEqual((await sources.add({ kind: 'codex-cli', models: ['test-codex'] })).aliases, aliases);
  const found = await sources.discover('ollama');
  assert.equal(found.models.length, 1);
  const local = await sources.add({ kind: 'ollama', models: ['local:test'] });
  await assert.rejects(sources.helper({ alias: local.aliases[0], prompt: 'task' }), /not been enabled/);
  await sources.delegateSetting(local.aliases[0], true);
  const result = await sources.helper({ alias: local.aliases[0], prompt: 'task' });
  assert.equal(result.text, 'helper answer');
  const sent = requests.find(r => r.url.endsWith('/api/chat')).body;
  assert.equal(sent.tools, undefined);
  assert.equal(sent.options.num_predict, 2048);
  await assert.rejects(sources.helper({ alias: local.aliases[0], prompt: 'x'.repeat(24001) }), /24,000/);
  await assert.rejects(sources.localAction('pull', '-bad'), /valid/);
  await assert.rejects(sources.localAction('pull', 'model:cloud'), /local model weights/);
  const job = await sources.localAction('load', 'local:test');
  for (let i = 0; i < 30 && job.state === 'running'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(job.state, 'done');
  assert.ok(requests.some(r => r.body?.keep_alive === '10m'));
  await sources.remove(aliases[0]);
  assert.equal((await sources.catalog()).default, local.aliases[0]);
  assert.equal((await sources.catalog()).models[local.aliases[0]].apiKey, undefined);
  console.log('PASS empty onboarding, discovery validation, idempotent additions, helper opt-in and local lifecycle');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
