# Connecting your machines

## What this version implements

A node is a running Distributed Orchestrator server. Pair any number of nodes
under Settings → Machines, then open a node or one of its sessions from the
Projects browser. The gateway forwards chat, streamed replies, uploads,
downloads, model settings and tools to the selected node. The remote node's
credentials remain server-side. Connections persist across gateway restarts.

Each node owns its sessions, repositories, files and subscription logins.
Remote operations execute exactly where the session lives. API and GPU endpoints
can be reached over your private network independently of the execution node.

**This is not yet a highly available shared-state cluster.** Node registries,
sessions, attachments and project files are not replicated. A dead gateway needs
a different bookmark; a dead execution node makes its sessions unavailable.
Three nodes do not enable consensus in this implementation. Do not sync the live
data folder with a file-sync tool or start several processes against one data
directory. No automatic takeover or task replay is attempted.

## Mac, Linux, Windows

macOS uses the existing shell/runtime. On Linux install Node.js 22+, Git, Bash,
and `lsof`. On Windows use WSL2 Ubuntu for the server and execution tools; native
Windows command execution is not implemented. In administrator PowerShell:

```powershell
wsl --install -d Ubuntu
```

Restart Windows if requested, then use the Ubuntu terminal for the remaining
server commands. Install Node.js 22+ there, as well as Git and lsof. WSL must be
running for the node to be available; closing Windows or terminating WSL stops it.
Linux shell execution does not provide macOS's sandbox-exec protection. Treat
nodes as trusted execution hosts and run them under a dedicated OS account.

On a **new machine**, after you have this revision from GitHub:

```sh
git clone https://github.com/jakelurie/Distributed-Orchestrator.git
cd Distributed-Orchestrator
npm ci
npm run node:setup
npm run node:serve
```

Setup writes a private `.orchestrator-node.env` in this checkout and refuses to
overwrite an existing config. It chooses port 8788 by default and checks that it
is available. Your old Mac setup keeps its existing data path, port, credentials,
and Tailscale rules: do not run the new-machine wizard over it. To pair that
existing node, it must require authentication (`HARNESS_TOKEN=auto`, or an
explicit token in its existing launcher), then be restarted with the new code.

## Private network and pairing

Install Tailscale and sign into your own tailnet on each execution host. For
WSL2 follow [Tailscale's WSL2 instructions](https://tailscale.com/docs/install/windows/wsl2);
WSL can have a distinct tailnet identity from Windows. Give nodes distinct names.
Use the standard installed client on the host. On Mac, detection tries the Mac
app and the CLI, preferring a connected client. Linux/WSL uses `tailscale` on
PATH. A custom installation can explicitly set `ORCHESTRATOR_TAILSCALE_BIN`
and/or `ORCHESTRATOR_TAILSCALE_SOCKET`; there is no automatic dependency on the
old `.tailscale-harness` daemon. Users keeping that daemon must explicitly set
its socket. Changing clients can change the hostname; update phone bookmarks.

Open **Settings → Phone access · Tailscale** on the host:

1. Install/open Tailscale and connect it to your tailnet. The screen includes
   the download link and a **check again** button.
2. Click **set up phone access**. This configures persistent, private HTTPS Serve.
   It reuses an existing matching private route, otherwise chooses port 443 or
   an unused port from 8443–8542. It never resets or overwrites existing routes.
3. If Tailscale requests HTTPS account approval, follow the displayed approval
   link, then retry. Permission errors require the host administrator to grant
   Serve access; the orchestrator never escalates privileges automatically.
4. Install Tailscale on the phone, sign into the same tailnet, and open the
   displayed phone address. Keep the host awake. The local address always uses
   loopback; a configured route does not prove a phone can reach it.

The launcher and web settings share the same status implementation. They
separate an unavailable client, login required, missing HTTPS route and a
configured route. Checks never change network settings. Hosting on Windows
currently uses WSL2; phones need only Tailscale and a browser. Node pairing is
separate from publishing a phone address:

1. Open the new node's URL with its access token (`?t=TOKEN`) once to establish
   a browser cookie. The token is in your private `.orchestrator-node.env`.
2. On the gateway, open **Settings → Machines**.
3. Enter the other node's name, reachable origin (no `/api` suffix), and token.
4. Connect. The server verifies protocol and authentication before saving.
5. Pair in the reverse direction if you want to access both nodes through either
   machine. Pairing is explicit; it never discovers or trusts the entire LAN.
6. The Projects browser shows connected nodes' sessions. Choose one to work on
   its owner. Use Machines → This machine to return to the gateway.

The token authorizes code execution. Store it only in the private setup file or
Machines form. Tokens and cookies from the phone are not forwarded to peers;
the gateway uses that peer's saved token. Disconnect removes this gateway's
access record; rotate the peer's token to revoke every holder of it.

## Keep a new Linux/WSL node running

For Linux or WSL with systemd enabled, create a user service, substituting your
checkout and the absolute path printed by `command -v node`:

```ini
[Unit]
Description=Distributed Orchestrator
After=network-online.target

[Service]
WorkingDirectory=/home/YOU/Distributed-Orchestrator
ExecStart=/ABSOLUTE/PATH/TO/node --env-file=.orchestrator-node.env server/index.js
Restart=on-failure
RestartSec=5
Environment=PATH=/YOUR/NODE/BIN:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

Save it as `~/.config/systemd/user/distributed-orchestrator.service`, then run
`systemctl --user daemon-reload` and
`systemctl --user enable --now distributed-orchestrator`. Linux users can enable
lingering to keep user services running when logged out. WSL also needs Windows
to start the distribution at login (for example a Task Scheduler login action
running `wsl.exe -d Ubuntu --exec /bin/true`). Verify startup after a Windows
reboot; do not assume installing a Linux unit starts WSL automatically.
Read logs with `journalctl --user -u distributed-orchestrator -f`.

## GPU and other AI sources

You can run a model server separately from a node. Install your preferred model
runtime on the GPU machine and choose a model it can run. No specific model is
hard-coded. Ollama provides an
[OpenAI-compatible endpoint](https://docs.ollama.com/api/openai-compatibility).
For access from a different node, configure its listening address according to
[Ollama's networking instructions](https://docs.ollama.com/faq) and restrict access
to your private network; do not expose an unauthenticated model endpoint publicly.

In **AI sources → Add AI source**, choose **Custom / local OpenAI-compatible API**:

- Endpoint: `http://GPU-PRIVATE-ADDRESS:11434/v1` (or your model server's endpoint).
- Model ID: the exact model installed in that server.
- Authentication: **No key (my private model server)** if appropriate; otherwise
  supply that server's API key. No-key mode does not forward an OpenAI env key.
- Select this source in a session on the node that will execute your tools.

The model runs on the GPU host; files and tools run on the session's node. When
the GPU host is offline, calls to that model fail; choose another source to
continue. CLI subscription sources must be installed and logged in on the
session's execution node. Existing API integrations remain available.

## Validation before depending on it

Create a disposable workspace on the second node, open its session from the
first, send a message, and attach/download a test file. Stop the second node:
its status should become offline and requests must fail without being replayed.
Restart it and verify the existing session returns. Stop the gateway and use
the second node's own bookmark. These are federation checks, not HA acceptance.

Remaining HA work: a versioned replicated metadata/transcript store, independent
voters with durable quorum decisions and fencing, worker leases, replicated
artifacts/project recovery, migration of existing local state, and a stable
frontend address with tested failover. Two-voter quorum cannot safely accept
writes after either voter fails; extra workers do not need to become voters.
