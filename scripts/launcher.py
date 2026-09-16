"""Browser-only frontend with a small native server controller."""
import os
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
    window.geometry('470x210')
    status = tk.StringVar(value='Starting…')
    ttk.Label(window, textvariable=status, wraplength=440).pack(pady=20)
    ttk.Label(window, text=url).pack()
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
            data = Path(env.get('HARNESS_DATA_DIR', str(Path.home() / 'Library/Application Support/harness')))
            try:
                token = (data / 'server-token').read_text().strip()
            except OSError:
                token = ''
        from urllib.parse import quote
        webbrowser.open(url + ('/?t=' + quote(token, safe='') if token else '/'))

    def stop():
        if child and child.poll() is None:
            child.terminate()
            status.set('Stopping…')
            stop_button.config(state='disabled')
        else:
            window.destroy()

    def close():
        if child and child.poll() is None:
            if not messagebox.askyesno('Stop server?', 'Stop this server? Phone access through this machine will also stop.'):
                return
            child.terminate()
        window.destroy()

    ttk.Button(window, text='Open browser', command=open_browser).pack(pady=10)
    stop_button = ttk.Button(window, text='Stop server', command=stop)
    stop_button.pack()
    window.protocol('WM_DELETE_WINDOW', close)
    if responding():
        status.set('Active — already running outside this launcher')
        stop_button.config(text='Close launcher')
    else:
        node = shutil.which('node')
        if not node:
            status.set('Install Node.js 22 or newer, then reopen.')
            stop_button.config(text='Close launcher')
        else:
            log = open(ROOT / '.launcher.log', 'a')
            child = subprocess.Popen([node, 'server/index.js'], cwd=ROOT, env=env, stdout=log, stderr=log)
            def update():
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
