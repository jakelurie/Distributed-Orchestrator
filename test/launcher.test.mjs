import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const pkg = JSON.parse(await fs.readFile('package.json'));
assert.equal(pkg.scripts.start, 'node scripts/launch.mjs');
assert.equal(pkg.devDependencies?.electron, undefined);
assert.equal(pkg.build, undefined);
// The Mac launcher uses platform tools; do not inherit an unrelated Homebrew Python.
const python = process.platform === 'darwin' ? '/usr/bin/python3' : 'python3';
const result = spawnSync(python, ['-c', `
import importlib.util, os, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('launcher', 'scripts/launcher.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
    m.ROOT = Path(d)
    (m.ROOT / '.orchestrator-node.env').write_text('HARNESS_PORT="9898"\\nORCHESTRATOR_NODE_NAME="Desktop"\\n')
    os.environ.pop('ORCHESTRATOR_NODE_NAME', None)  # isolate the file fallback from the test runner's host name
    os.environ['HARNESS_PORT'] = '9899'
    result = m.configuration()
    assert result['HARNESS_PORT'] == '9899'
    assert result['ORCHESTRATOR_NODE_NAME'] == 'Desktop'
    del os.environ['HARNESS_PORT']
    assert m.configuration()['HARNESS_PORT'] == '9898'
`], {encoding:'utf8'});
assert.equal(result.status, 0, result.stderr);
console.log('PASS browser-only package and launcher configuration precedence');

// The checked-in platform helpers no longer clutter the project root.
for (const extension of ['command', 'cmd', 'sh']) {
  await assert.rejects(fs.access('Launch Distributed Orchestrator.' + extension));
}
if (process.platform === 'darwin') {
  const build = spawnSync(python, ['scripts/build-launcher.py'], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const bundle = 'Launch Distributed Orchestrator.app';
  await fs.access(bundle + '/Contents/MacOS/OrchestratorLauncher', fs.constants.X_OK);
  const verified = spawnSync('codesign', ['--verify', '--deep', '--strict', bundle], { encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr);
}
console.log('PASS single Finder launcher and platform helpers under scripts');
