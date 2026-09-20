import assert from 'node:assert/strict';
import { executableAvailable, modelInventory, machineHelp } from '../src/core/machine-help.js';
import { runTool } from '../src/core/tools.js';

const config = { default: 'astra', models: {
  astra: { provider: 'codex-cli', hasKey: true },
  claude: { provider: 'claude-cli', hasKey: true, apiKey: 'never-export-this' },
  api: { provider: 'openai', hasKey: false },
} };
const probe = async bin => bin === 'claude';
const inventory = await modelInventory(config, probe);
assert.equal(inventory.models.astra.available, false);
assert.equal(inventory.models.claude.available, true);
assert.equal(inventory.models.api.available, false);
assert.equal(inventory.default, 'claude');
assert.ok(!JSON.stringify(inventory).includes('never-export-this'));
assert.equal(await executableAvailable(process.execPath), true);
assert.equal(await executableAvailable('/no-such-harness-test-binary'), false);
assert.equal((await modelInventory(config, async () => false)).default, null);
let called = false;
const report = await machineHelp(config, { id: 'two', name: 'Machine 2', secret: 'hidden' },
  { question: 'Can Astra run here?', useClaude: true }, { probe, complete: async args => {
    called = true;
    assert.equal(args.useTools, false);
    assert.equal(args.spec.maxTurns, 1);
    assert.ok(!JSON.stringify(args.events).includes('never-export-this'));
    return { text: 'Codex is not installed.' };
  } });
assert.ok(called);
assert.equal(report.answer, 'Codex is not installed.');
assert.ok(!JSON.stringify(report).includes('hidden'));
await assert.rejects(machineHelp(config, {}, { question: 'x'.repeat(4001) }, { probe }));
await assert.rejects(machineHelp(config, {}, { useClaude: true }, { probe: async () => false }), /No installed/);
const result = await runTool({ name: 'machine_help', args: { host: 'two' } }, {
  machineHelp: async args => { assert.equal(args.host, 'two'); return report; },
});
assert.equal(result.ok, true);
assert.equal((await runTool({ name: 'machine_help' }, {})).ok, false);
console.log('Machine diagnostics, availability, and Claude snapshot checks passed.');
