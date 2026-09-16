"""Browser-only frontend with a small native server controller."""
import os
import json
from pathlib import Path
import shutil
import subprocess
import tkinter as tk
from tkinter import ttk, messagebox
import urllib.request
import urllib.error
import webbrowser

ROOT = Path(__file__).resolve().parent.parent

def configuration():
    env = os.environ.copy()
    file = ROOT / '.orchestrator-node.env'
    if file.exists():
        for line in file.read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            key, value = line.split('=', 1)
            env.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return env

def main():
    env = configuration()
    url = 'http://127.0.0.1:' + env.get('HARNESS_PORT', '8787')
    window = tk.Tk()
    window.title('Distributed Orchestrator')
    window.geometry('570x340')
    status = tk.StringVar(value='Starting…')
    ttk.Label(window, textvariable=status, wraplength=440).pack(pady=20)
    ttk.Label(window, text=url).pack()
    phone_status = tk.StringVar(value='Phone: checking…')
    phone_url = tk.StringVar(value='')
    ttk.Label(window, textvariable=phone_status, wraplength=540).pack(pady=8)
    ttk.Entry(window, textvariable=phone_url, state='readonly', width=65).pack()
    def copy_phone():
        window.clipboard_clear()
        window.clipboard_append(phone_url.get())
    ttk.Button(window, text='Copy phone link', command=copy_phone).pack()
    def refresh_connections():
        probe = subprocess.Popen([shutil.which('python3') or 'python3', str(ROOT / 'scripts/connection-status.py')],
                                 env=env, stdout=subprocess.PIPE, text=True)
        def complete():
            if probe.poll() is None:
                window.after(100, complete)
                return
            try:
                info = json.loads(probe.stdout.read())
                if not stopping:
                    status.set('This machine: ' + info['localStatus'])
                phone_status.set('Phone: ' + info['phoneStatus'])
                phone_url.set(info['phoneUrl'])
            except (ValueError, KeyError):
                phone_status.set('Phone: status unavailable')
            window.after(6000, refresh_connections)
        window.after(100, complete)
    window.after(500, refresh_connections)
    child = None
    log = None

    def responding():
        try:
            with urllib.request.urlopen(url, timeout=0.4) as response:
                return b'Distributed Orchestrator' in response.read(8192)
        except urllib.error.HTTPError as error:
            return error.code == 401
        except (OSError, urllib.error.URLError):
            return False

    def open_browser():
        token = env.get('HARNESS_TOKEN', '')
        if token == 'auto':
            data = Path(env.get('HARNESS_DATA_DIR', str(Path.home() / ('Library/Application Support/harness' if __import__('sys').platform == 'darwin' else '.local/share/distributed-orchestrator'))))
            try:
                token = (data / 'server-token').read_text().strip()
            except OSError:
                token = ''
        from urllib.parse import quote
        webbrowser.open(url + ('/?t=' + quote(token, safe='') if token else '/'))

    stopping = False

    def stop(close_window=False):
        nonlocal stopping
        if stopping:
            return
        stopping = True
        if child and child.poll() is None:
            child.terminate()
        status.set('Stopping…')
        stop_button.config(state='disabled')
        try:
            helper = subprocess.Popen(
                [shutil.which('node') or 'node', str(ROOT / 'scripts/stop-server.mjs'),
                 str(ROOT), env.get('HARNESS_PORT', '8787')],
                env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        except OSError as error:
            stopping = False
            status.set(str(error))
            stop_button.config(state='normal')
            return
        def finished():
            nonlocal stopping
            if helper.poll() is None:
                window.after(100, finished)
                return
            stopping = False
            if helper.returncode == 0:
                if close_window:
                    window.destroy()
                else:
                    status.set('Stopped')
                    stop_button.config(text='Close launcher', state='normal', command=window.destroy)
            else:
                status.set(helper.stderr.read())
                stop_button.config(state='normal')
        window.after(100, finished)

    def close():
        stop(close_window=True)

    ttk.Button(window, text='Open browser', command=open_browser).pack(pady=10)
    stop_button = ttk.Button(window, text='Stop server', command=stop)
    stop_button.pack()
    window.protocol('WM_DELETE_WINDOW', close)
    if responding():
        status.set('Active — closing this window stops the server')
    else:
        node = shutil.which('node')
        if not node:
            status.set('Install Node.js 22 or newer, then reopen.')
            stop_button.config(text='Close launcher')
        else:
            log = open(ROOT / '.launcher.log', 'a')
            child = subprocess.Popen([node, 'server/index.js'], cwd=ROOT, env=env, stdout=log, stderr=log)
            def update():
                if stopping:
                    return
                if child.poll() is not None:
                    status.set('Stopped' if child.returncode in (0, -15) else 'Server exited — see .launcher.log')
                    stop_button.config(text='Close launcher', state='normal')
                    return
                status.set('Active' if responding() else 'Waiting for server — see .launcher.log')
                window.after(1500, update)
            window.after(300, update)
    window.mainloop()
    if log:
        log.close()

if __name__ == '__main__':
    main()
