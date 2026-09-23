import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const pkg = JSON.parse(await fs.readFile('package.json'));
assert.equal(pkg.scripts.start, 'node scripts/launch.mjs');
assert.equal(pkg.devDependencies?.electron, undefined);
assert.equal(pkg.build, undefined);
console.log('PASS browser-only package');

// The checked-in platform helpers no longer clutter the project root.
for (const extension of ['command', 'cmd', 'sh']) {
  await assert.rejects(fs.access('Launch Distributed Orchestrator.' + extension));
}
if (process.platform === 'darwin') {
  // The Mac launcher uses platform tools; do not inherit an unrelated Homebrew Python.
  const python = '/usr/bin/python3';
  const build = spawnSync(python, ['scripts/build-launcher.py'], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const bundle = 'Launch Distributed Orchestrator.app';
  await fs.access(bundle + '/Contents/MacOS/OrchestratorLauncher', fs.constants.X_OK);
  const verified = spawnSync('codesign', ['--verify', '--deep', '--strict', bundle], { encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr);
}
console.log('PASS single Finder launcher and platform helpers under scripts');
