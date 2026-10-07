# Distributed Orchestrator

Run AI coding sessions from your computer or phone. Keep projects in one place,
switch models during a conversation, and connect other computers to use their
models and files.

## Get started

1. Install **Node.js 22 or newer**, **Git**, and **Tailscale**. Connect Tailscale.
2. Clone this repository.
3. Open **start_mac.command** on Mac or **start_windows.cmd** on Windows.
   It installs dependencies, starts DO, and opens your browser. Keep the terminal open.
4. Open **Settings → AI sources** and connect a model.
5. Create a project and start a session.

The default address on the hosting computer is **http://127.0.0.1:8787**.
Windows runs without WSL. On Mac, `npm start` builds and opens the optional native
launcher; that requires Python 3 and Apple Command Line Tools.

## Choose your AI

You can use any of these three setups:

- **Subscription:** install Claude Code or Codex and sign in on the computer
  running your session. In AI sources, check the login and add the models you
  want. This uses the CLI's existing login; you don't need to supply an API key.
- **API:** add a provider and your API key in AI sources. API billing is separate
  from subscriptions.
- **Local model:** install Ollama, then add or download a model through AI sources.
  The computer needs enough memory for that model. A GPU can help; models without
  tool support are limited to chat.

Sources belong to the computer where you set them up. That computer must be on
and reachable to use them. You can switch a session's model and keep its conversation.
Changing the coding model does not change any AI integration inside the app you're building.

Settings, logins, and API keys aren't included in your project's GitHub repository.
Voice dictation is optional and has its own setup under **Settings → Voice setup**;
it requires an OpenAI API key even if your coding sessions use a subscription.

For optional classification, routing and scoring, add a TypeSafe key in
**Settings → Jev · TypeSafe**. Project agents can use Jev through Harness without
reading the key. It is shared with paired computers. Saving it does not test
account access; requests use your TypeSafe API account. See the
[TypeSafe API documentation](https://docs.typesafe.ai/api).

## Projects and sessions

A project has a folder and can have several sessions. Use **agent** mode to work
on files or **chat** mode for conversation without tools. Apps with a start command
can be launched from their project card.

**DO stays first in the project list.** Other projects are ordered by the latest
message you sent in any of their sessions. Open a project to reach its sessions.

Each coding session works in its own Git worktree, so sessions can edit separately.
The built-in Harness project is where you change DO itself.

## Save and publish your work

Edits stay local until you press **Push**. Open it to review the selected session's
changes, then push to GitHub. DO commits the changes, merges other updates, runs
the project's checks, and publishes if those checks pass.

For a new project, the panel lets you create a GitHub repository and choose
Private or Public. Private is the default. Connect your GitHub account in Settings first.

If a merge or check fails, the work stays in the session for you to fix and retry.
Nothing is automatically published at the end of a conversation.

Projects need checks before they can be published. Node projects use `npm test`,
with dependencies installed first. For another setup, add a
`.harness-integration.json` file, for example:

```json
{"command": "python -m pytest"}
```

That command should install any required dependencies and run the project's checks.

## Use your phone or another computer

For phone access, install Tailscale on your phone and join the same private network.
Open **Settings → Phone access · Tailscale** in DO and use the phone link it shows.
The localhost address only works on the hosting computer.

To add another computer, follow the [machine setup guide](docs/machines.md), then
pair it under **Settings → Machines**. Configure its AI sources separately.
An existing coding session stays with its original computer; reconnect that
computer to continue its work.

DO can run shell commands and edit files. Keep it on a trusted private network;
don't expose it to the public internet. Tailscale must stay connected to use DO.

## Update DO

Publishing a DO change and running that change are separate steps. A running
server needs to restart to load new code.

Use **Restart and updates** in Settings to inspect the running version on each
computer and restart the one you want to update. Check the running commit after
restart; don't assume every paired computer has updated just because one has.

The launch scripts check for repository updates before starting. If local edits
or a Git problem prevent an update, resolve that problem before retrying.

## Development

Coding sessions are instructed to include tracing for future debugging: what the
user did, what the app showed, and what happened behind the scenes. Logs are for
the coding assistant to read, not extra UI for the user. They should be bounded,
redacted, kept out of Git, and documented so the next session can find them.
This is a development instruction; existing apps still need tracing added.

To run the current checkout directly:

```sh
npm ci
npm run serve
```

After editing server or UI code, restart the server to load it.

Run the tests with:

```sh
npm test
```

The tests start real servers with temporary data and simulated AI and Tailscale
services. They cover distributed sessions, network recovery, and restarts.
They don't need API keys and don't test browser clicks.

Main files:

- `server/index.js` — HTTP server and API routes.
- `server/public/` — browser UI for desktop and phone.
- `src/core/` — agents, models, projects, Git, and machine connections.
- `test/e2e/` — end-to-end tests.
- `scripts/` — launchers and setup.

## Licence

MIT.
