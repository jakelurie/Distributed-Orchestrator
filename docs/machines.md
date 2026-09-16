# Connecting your machines

## Shared system and failover

Settings → Machines shows the current host, every joined host, recorded browser
viewers, and devices observed through the installed Tailscale client. Host status
means the orchestrator responded; Tailscale status means the device is online on
that network. These are separate. Browser activity is a heartbeat, not proof that
a person is looking at the screen. Sleeping phones become disconnected after
45 seconds and keep their history. Different browser profiles count as different
viewers; this app cannot enumerate devices hidden by Tailscale permissions or
ones that disappeared before it first observed them.

A new installation starts as a one-host system. On the existing main, select
**create join code**. On the new host, use Phone access to publish its private
HTTPS address, then enter the main address and code under **Join an existing
system**. Codes are one-use and expire in ten minutes. Presence on the same
Tailscale network does not silently authorize access to files, API keys or tools.
After joining, membership, sessions, viewer history, and portable configuration
synchronize without reverse pairing. There is no configured host/viewer count
limit; CPU, disk and network capacity still apply.

- **One host:** independent operation, with no other host available for failover.
- **Two hosts:** either can take over after missed heartbeats. This explicitly
  prioritizes availability: a partition can produce two mains and divergent
  changes. Losing log branches are preserved as `cluster/conflict-*.json` for
  manual recovery, with a warning in Machines. They are not silently merged.
- **Three or more hosts:** majority voting and a replicated log select the main
  and commit shared session changes. An isolated minority stops accepting work.
  Membership upgrades use joint voting; both existing hosts must participate
  when upgrading from two to three. Adding hosts never automatically shrinks the
  voter set when another host goes offline.

Preferred main biases the next election. It does not interrupt a healthy current
main just to move work. Heartbeats run every 700 ms; elections begin after roughly
3.5–6.5 seconds without a main, subject to connection latency. Running turns are
aborted after quorum loss is detected. Already-started external side effects and
background programs cannot be undone or fenced by a JavaScript coordinator.
Uncertain sends/tools are **not automatically replayed** after a failure.

Sessions are persisted in the cluster log before a shared save succeeds.
Model definitions, API secrets and app records are copied only through authenticated
cluster transport; therefore join only computers you trust with those secrets.
Host-specific subscription CLI logins, network configuration, notification services,
usage ledgers and live processes remain local. Shared model/app setting mutations wait for their checkpoint to commit before
reporting success.

Project working files checkpoint at onboarding and agent saves. Recovery restores
them into a new generation under `~/Projects/OrchestratorWorkspaces`, preserving
other hosts' original folders. Checkpoints exclude dependencies, build output,
logs, symlinks, `.env` files and Git internals. They currently support 48 MB total
and 16 MB per file. Larger datasets require separate storage. Reinstall dependencies
and provide local secrets when needed. Files modified externally between checkpoints,
open processes and uncommitted in-flight tool effects are not covered by workspace
recovery. Uploaded attachment bytes are replicated with checksums and restored
into the receiving host’s attachment store. The built-in orchestrator project uses each host's
own checkout rather than copying a running installation over another.

A visited phone browser caches the public app shell and approved peer addresses.
If its host goes away, it probes those peers and moves to the elected main, carrying
an unsent text draft and a short-lived signed login ticket. No mutation is retried.
This requires a secure browser with service workers, a prior successful visit,
and a reachable peer; it is not a floating DNS name. An expired ticket, cleared
browser storage, or a first visit to a dead host still requires another host's
bookmark and login. Tailscale machine names remain device addresses.

This is a new implementation with automated crash/partition/rejoin tests, not a
claim of production-grade consensus verification. Keep backups. Remote power
on/off is not implemented.

## Mac, Linux, Windows

Install Node.js 22+, Git, and the native Tailscale app on the new computer.
Windows uses Git for Windows and the normal Windows Tailscale application.
No WSL or Ubuntu installation is required. For GitHub authorization install
GitHub CLI as well. Install the desired model CLIs separately on execution hosts.

Clone this repository, then run the entry point in its root:

| System | Launcher |
| --- | --- |
| Windows | Double-click `start_windows.cmd` |
| macOS | Double-click `start_mac.command` |
| Linux | `sh start_linux.sh` |
| Ubuntu | `sh start_ubuntu.sh` |

The launcher installs npm dependencies on first use, creates a private
`.orchestrator-node.env` without overwriting existing settings, starts the server,
and opens the browser with its login token. Keep the terminal window open.
Port 8787 is the default; if occupied, stop the old server or edit HARNESS_PORT
in that config. The launcher never kills a process already using the port.
For interactive configuration instead, run `npm run node:setup` followed by
`npm run node:serve`. The wizard defaults to 8788.

On the new host, open **Settings → Phone access · Tailscale** and set up HTTPS.
On the existing host choose **Machines → create join code**. On the new host
choose **Machines → Join an existing system**, then enter both HTTPS addresses
and the code. Approve Windows Firewall access on your private network if prompted.

The existing Mac desktop launcher remains available. Native Windows process
status uses PowerShell instead of lsof; Windows apps must listen on their assigned
PORT to be detected reliably. Linux requires Bash and lsof for process discovery.
Platform-specific project commands still need to be appropriate for that OS.

## Private network and pairing

Install Tailscale and sign into your own tailnet on each execution host.
Give nodes distinct names. Use the standard installed client on the host.
Mac detection tries the Mac app and CLI. Windows tries PATH and the standard
Program Files installation. Linux uses `tailscale` on
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
configured route. Checks never change network settings. Windows runs natively; phones need only Tailscale and a browser. Shared-system joining is separate from publishing a phone address. The older
explicit remote-execution pairing API remains available for compatibility:

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

## Keep a new Linux node running

For Linux with systemd enabled, create a user service, substituting your
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
lingering to keep user services running when logged out.
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

The automated tests cover durable election state, three-host majority loss,
isolated-minority rejection, two-host takeover, reconnection, one-to-three-host
onboarding over HTTP, checksummed workspace recovery, remembered network devices,
and browser selection of approved peers without replaying sends. The server test
starts three real processes, kills the main with SIGKILL, and checks session edits,
viewer records, model configuration and attachment downloads on the replacement.

Before relying on this across your actual Mac/PC/phone, join a disposable second
host, verify its private HTTPS URL from the phone, and open the updated app once
so its offline shell and peer list are stored. Create a test session/file, stop
the main, and verify the phone reconnects and the recovered project opens. Test
three hosts under a network split as well: a lone host must not accept changes.
A two-host network split intentionally has weaker guarantees, with conflict
archives requiring manual review. Remote power controls remain future work.

## GitHub connection

Open global **Settings → GitHub connection → Connect GitHub**. Enter the
one-time code on GitHub and approve access. Keep the settings screen open or
reopen it to finish. The saved system connection synchronizes to paired hosts.
This is the same flow for everyone, including users previously signed in through
GitHub CLI. Existing CLI credentials are not changed, but do not count as a saved
system connection. GitHub CLI must be installed on execution hosts.

Authorization uses temporary CLI configuration. If the main host changes during
login, restart authorization on the new main. Completed connections replicate.

Before connecting, automatic Git saves remain local; cluster synchronization
continues independently. After connecting, sessions with automatic Git enabled
push changed turns and can create private app repositories. Connecting does not
bulk-publish existing projects. Repository visibility and automatic Git controls
remain under **Edit session → Git & GitHub**. GitHub is for project files and
commits, not a backup of the orchestrator's session database or credentials.
