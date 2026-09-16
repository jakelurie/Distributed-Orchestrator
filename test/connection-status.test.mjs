import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const result = spawnSync('python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location('status', 'scripts/connection-status.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
config = {'Web': {'host.ts.net:443': {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:8787'}}},
                  'host.ts.net:8443': {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:8788'}}}}}
assert m.phone_route(config, 8787) == 'https://host.ts.net/'
assert m.phone_route(config, 8788) == 'https://host.ts.net:8443/'
assert m.phone_route(config, 9999) is None
m.urllib.request.urlopen = lambda *a, **k: (_ for _ in ()).throw(OSError('offline'))
def run(args, **kwargs):
    return json.dumps(config if 'serve' in args else {'BackendState': 'Running'})
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
assert r['phoneStatus'] == 'Route active; phone reachability unverified'
r = m.inspect({'HARNESS_PORT':'9999'}, run)
assert r['phoneStatus'] == 'No Tailscale route to this server'
m.platform.system = lambda: 'Darwin'
commands = []
def mac_app(args, **kwargs):
    commands.append(args)
    if args[0] == 'tailscale': raise OSError('legacy daemon absent')
    return run(args, **kwargs)
r = m.inspect({'HARNESS_PORT':'8787'}, mac_app)
assert r['phoneUrl'] == 'https://host.ts.net/'
assert any(c[0] == '/Applications/Tailscale.app/Contents/MacOS/Tailscale' for c in commands)
commands.clear()
r = m.inspect({'HARNESS_PORT':'8787', 'ORCHESTRATOR_TAILSCALE_SOCKET':'/explicit'}, mac_app)
assert r['phoneStatus'] == 'Tailscale unavailable'
assert all(c[0] == 'tailscale' for c in commands)
def failed(*a, **k): raise OSError('daemon absent')
r = m.inspect({'HARNESS_PORT':'8787'}, failed)
assert r['phoneStatus'] == 'Tailscale unavailable'
assert r['phoneUrl'] == ''
`], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
console.log('PASS phone routes match local port; missing daemon and offline server are reported separately');
