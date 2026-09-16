import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const result = spawnSync('python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location('status', 'scripts/connection-status.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.urllib.request.urlopen = lambda *a, **k: (_ for _ in ()).throw(OSError('offline'))
def run(args, **kwargs):
    assert args[0] == 'node' and args[1].endswith('network-status.mjs')
    return json.dumps({'phoneUrl': 'https://host.ts.net/', 'ready': True,
                       'message': 'Private HTTPS route configured; phone reachability unverified.'})
r = m.inspect({'HARNESS_PORT':'8787'}, run)
assert r['localStatus'] == 'Offline'
assert r['phoneStatus'] == 'Offline — local server stopped'
class Reply:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, n): return b'<title>Distributed Orchestrator</title>'
m.urllib.request.urlopen = lambda *a, **k: Reply()
r = m.inspect({'HARNESS_PORT':'8787'}, run)
assert r['localStatus'] == 'Active'
assert r['phoneStatus'] == 'Private HTTPS route configured; phone reachability unverified.'
def failed(*a, **k): raise OSError('daemon absent')
r = m.inspect({'HARNESS_PORT':'8787'}, failed)
assert 'Connection check failed' in r['phoneStatus']
assert r['phoneUrl'] == ''
`], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
console.log('PASS phone routes match local port; missing daemon and offline server are reported separately');
