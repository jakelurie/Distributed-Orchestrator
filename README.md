# Distributed Orchestrator

A control plane for AI work across apps, workspaces, and sessions.

Run a project against swappable models — Claude, GPT, or a local one — and
switch between them mid-session with the conversation intact. Drive it from a
browser on your computer or phone.

Built to answer one question honestly: *given the same project and the same
history, what do different models actually do?*

## What it is

- **Apps are the durable thing; sessions are workers.** An app owns a folder, a
  repository, a port and a start command, and survives reboots — you relaunch it
  from the dashboard. Sessions attach to an app, several at once, each free to
  run a different model. That is how you compare agents: one app, two sessions.
- **Browser interface.** The laptop and phone use the same server. A small native launcher provides status, a browser link, and a stop control.
- **Mid-session model switching.** The transcript is provider-neutral, so a
  session can move from Claude to GPT to a local model and keep its history.
  Tool-call ids are preserved across the switch, which is the part that usually
  breaks.
- **Per-session monitoring.** A second tab per session with a live panel of the
  processes that session started, plus a chat whose whole job is that panel —
  it can rewrite what the panel shows on request.
- **Usage accounting.** Token and cost totals per model over any window, kept
  in an incrementally-updated ledger rather than recomputed from transcripts.
  Subscription CLIs report their real plan limits, read back from what each CLI
  records on disk.
- **Supervision that assumes things go wrong.** Every turn keeps a liveness
  beacon; a watcher outside the model raises an alarm when one stops making
  progress, because a stalled agent cannot be the thing that notices. A turn
  that ends without saying anything gets one bounded call to write its summary,
  and a turn interrupted by a shutdown records that in its own transcript.
- **Sessions cannot modify the harness.** File tools refuse writes into it above
  every per-session setting, and the shell runs under a kernel sandbox
  (`sandbox-exec`) so a path assembled at runtime is refused too. Reading is
  allowed; a session can study the harness, it just cannot change it.

## Requirements

- Node 20+
- For Claude without an API key: the [`claude` CLI](https://claude.com/claude-code),
  logged in. The harness shells out to it, so it borrows your existing session.
- For OpenAI models: an API key from platform.openai.com. **A ChatGPT Plus
  subscription does not include API access** — they are separate products.
- For local models: [Ollama](https://ollama.com) or anything else serving
  `POST /v1/chat/completions`.

## Setup

```bash
npm install
npm run serve      # the harness; open the printed URL on any device
npm start          # native launcher
npm test           # the suite
```

On first run a `models.json` is written to your OS application-support
directory (`~/Library/Application Support/harness` on macOS). Copy
`models.json.example` over it as a starting point and edit, or configure
everything from the app's settings screen.

**Keys are never stored in this repo.** They live in `secrets.json` next to
`models.json`, mode 0600, or come from environment variables. Add them through
the UI rather than editing files.

## Connecting machines

Use `npm run node:setup` on a new machine, then `npm run node:serve`.
Pair nodes under **Settings → Machines**. Any number of nodes can be connected;
remote sessions and file transfers stay on their owning machine.
See [machine setup, native Windows, GPU models, and availability limits](docs/machines.md).
Settings → Machines now supports a shared cluster with replicated sessions and
automatic main-host election. Two hosts prioritize availability; three or more
require a majority. See the recovery and browser-failover limits in the setup guide.

## Using it from a phone

`npm run serve` binds to your LAN and prints a URL. Set `HARNESS_TOKEN=auto` to
require an access token that persists across restarts; leave it unset and the
server is open to anyone on the network.

**The agent runs shell commands on the machine hosting it.** Treat the URL as a
credential. To reach it away from home, put both devices on a private network —
[Tailscale](https://tailscale.com) works well and needs no ports opened — rather
than exposing it publicly.

Open **Settings → Phone access · Tailscale** to check the host's connection and
set up its private HTTPS address. Install Tailscale on your phone and sign into
the same network, then use the displayed phone link. Setup preserves existing
Serve routes and keeps the local address available. Standard Mac and Linux
installations work without the former custom daemon. See [machine onboarding](docs/machines.md).

## Providers

### Voice dictation from a phone

After updating, restart the harness server and refresh the phone page. Open
**Settings → Voice setup** and save an OpenAI API key (API billing is separate
from ChatGPT/Codex subscriptions). The server stores it with the other secrets;
`OPENAI_API_KEY` is also supported as a fallback.

Open the chat using its HTTPS Tailscale URL, tap **🎙**, allow microphone access,
and tap **■** when finished. The server sends the recording to OpenAI's
`gpt-transcribe` model and inserts the transcript into your draft for review.
Nothing is sent to the chat until you press **send**. Recordings stop after five
minutes; failed uploads can be retried while the page stays open. Cancel,
switching sessions or tabs, and leaving the page discard the pending recording.
Audio is processed in memory and is not saved by the harness.

See [OpenAI transcription documentation](https://developers.openai.com/api/docs/guides/speech-to-text)
for supported API behavior and [model pricing](https://developers.openai.com/api/docs/models/gpt-transcribe).

| `provider` | for | key |
| --- | --- | --- |
| `claude-cli` | Claude via the local CLI | none — it holds your login |
| `openai` | anything speaking `/v1/chat/completions` | only if the endpoint wants one |
| `openai-responses` | OpenAI models that need `/v1/responses` | yes |
| `anthropic` | the Anthropic API directly | `ANTHROPIC_API_KEY` |

Some notes learned the hard way, encoded in `models.json.example`:

- `gpt-6-astra` will not do function tools on `/v1/chat/completions` at all —
  it needs `openai-responses`.
- Newer OpenAI models renamed `max_tokens` to `max_completion_tokens`. The
  provider retries with whichever the API asks for.
- Small quantised local models often emit tool calls as plain text rather than
  using the tool schema. `parseTextToolCalls: true` recovers those.
- Models that reprice above a token threshold take `softLimitTokens`, and the
  transcript is trimmed to stay under it unless a session opts out.

## Sessions

Each session has a project directory, a model, and a mode:

- **agent** — tools, project rules, works in the directory.
- **chat** — no tools, minimal prompt. Roughly 85 input tokens instead of 1,300,
  which matters on small models where a large tool-oriented prompt causes bad
  behaviour.

A session is confined to its project directory. It can be granted other folders
as **read-only**, for one project that consumes another's output.

Turn on **push after each turn** and the file changes a turn produced are
committed and pushed. Commit messages describe the files and which model changed
them — never what you typed.

## Layout

```
src/core/        agent loop, transcript, tools, providers, usage, git
scripts/         native launcher and machine setup
server/          LAN server and phone UI
test/            suites, run with `npm test`
python-cli/      the original CLI prototype, archived
```

## Licence

MIT.


## Browser launcher

On macOS double-click **Launch Distributed Orchestrator.app** in this folder.
It opens only the small native window, without Terminal. Keep the app in this
folder so it can locate the server. After cloning, run `npm start` once to build
it (or `python3 scripts/build-launcher.py`). The generated bundle is not committed.
For a fresh clone on any OS, install Node.js 22+, Git, and Tailscale, then use
**start_windows.cmd**, **start_mac.command**, **start_linux.sh**, or
**start_ubuntu.sh** in the repository root. These entry points install dependencies,
start the server, and open your browser. Keep their terminal window open.
Windows runs natively without WSL. See [machine onboarding](docs/machines.md)
for joining your existing system. The Mac Cocoa launcher requires Apple Command
Line Tools; the root start_mac.command does not require Swift or Python.

The small native window shows server status, the local URL, Open browser, and
Stop server. The main interface runs in your normal browser. Server output goes
to .launcher.log. Closing the window stops this checkout's server, including a
server that was already running when the launcher opened. Stop server does the
same without closing the window. The launcher verifies the listening process
belongs to this checkout and waits for shutdown. If an external service restarts
it, the window stays open with an error; disable that service before retrying.

The launcher reads .orchestrator-node.env when present, otherwise existing
environment variables and the default local port 8787. No Tailscale rules change.
Existing installed Electron bundles can be removed manually; this checkout no
longer uses Electron. The project lives in DistributedOrchestratorCore. Built-in sessions follow the
current checkout path; no legacy folder symlink is required.

The launcher displays separate local-server and phone-route status, refreshed
periodically. Copy phone link uses the Tailscale HTTPS route that targets this
node's actual HTTP port. An active route is not proof that the phone is connected
to the tailnet: the window explicitly reports phone reachability as unverified.
If Tailscale is stopped, the window reports it rather than claiming phone access
is active. It does not replace your Tailscale identity or change serving rules.
An optional ORCHESTRATOR_PHONE_URL can display your known phone bookmark while
Tailscale is unavailable; this does not mark that address as active.
