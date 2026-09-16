"""Read-only local and Tailscale serving checks; never edits network rules."""
import json
import os
import platform
import subprocess
import urllib.request
import urllib.error


def phone_route(config, port):
    for host, site in config.get('Web', {}).items():
        for route, handler in site.get('Handlers', {}).items():
            if route != '/':
                continue
            if handler.get('Proxy', '').rstrip('/') in (
                    'http://127.0.0.1:' + str(port), 'http://localhost:' + str(port)):
                return 'https://' + host.removesuffix(':443') + '/'
    return None


def inspect(env=None, run=subprocess.check_output):
    env = env or os.environ
    port = env.get('HARNESS_PORT', '8787')
    local = 'http://127.0.0.1:' + port
    active = False
    try:
        with urllib.request.urlopen(local, timeout=2) as response:
            active = b'Distributed Orchestrator' in response.read(8192)
    except urllib.error.HTTPError as e:
        active = e.code == 401
    except OSError:
        pass
    result = {'localUrl': local, 'localStatus': 'Active' if active else 'Offline',
              'phoneUrl': env.get('ORCHESTRATOR_PHONE_URL', ''), 'phoneStatus': 'Tailscale unavailable'}
    socket = env.get('ORCHESTRATOR_TAILSCALE_SOCKET',
                     os.path.expanduser('~/.tailscale-harness/tailscaled.sock') if platform.system() == 'Darwin' else '')
    command = ['tailscale'] + (['--socket=' + socket] if socket else [])
    # An explicit socket is authoritative. Otherwise try the installed Mac app
    # when the legacy standalone daemon is absent.
    if platform.system() == 'Darwin' and 'ORCHESTRATOR_TAILSCALE_SOCKET' not in env:
        try:
            run(command + ['status', '--json'], timeout=4, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError):
            command = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale']
    try:
        state = json.loads(run(command + ['status', '--json'], timeout=4, stderr=subprocess.DEVNULL))
        if state.get('BackendState') != 'Running':
            result['phoneStatus'] = 'Tailscale needs login or startup'
            return result
        config = json.loads(run(command + ['serve', 'status', '--json'], timeout=4, stderr=subprocess.DEVNULL))
        route = phone_route(config, port)
        if route:
            result['phoneUrl'] = route
            result['phoneStatus'] = 'Route active; phone reachability unverified' if active else 'Offline — local server stopped'
        else:
            result['phoneStatus'] = 'No Tailscale route to this server'
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return result


if __name__ == '__main__':
    print(json.dumps(inspect()))
