/**
 * LAN server: the same harness core, driven from a phone.
 *
 * Everything here is a thin shell over src/core - the identical agent loop,
 * store and providers the desktop app uses, against the identical data
 * directory. A session started on the phone opens in the desktop app and the
 * other way round.
 *
 * Access control: this process runs shell commands on this machine, so every
 * request must carry the token printed at startup. The token is bound into the
 * URL once and then kept in a cookie.
 */

import { queueKey, unfinished } from '../src/core/project-queue.js';
import { setTimeout as pause } from 'node:timers/promises';
import { createMessageQueue } from '../src/core/message-queue.js';
import { defaultDataDir } from '../src/core/platform.js';
import { execFile, spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { replicatedAssets } from '../src/core/cluster/assets.js';
import { portableWorkspaces } from '../src/core/cluster/workspaces.js';
import { appPlacement, replicationHosts } from '../src/core/cluster/placement.js';
import { deviceInventory } from '../src/core/cluster/devices.js';
import { hostPairing } from '../src/core/cluster/pairing.js';
import { executionHosts, executionOwner, assignmentError, sessionWriteError, recoverStoppedTurn } from '../src/core/cluster/execution.js';
import { createCluster } from '../src/core/cluster/index.js';
import { restartPeers } from '../src/core/cluster/restart.js';
import { createNodes } from '../src/core/nodes.js';
import { runTurn } from '../src/core/agent.js';
import { loadConfig, patchModel, addModel } from '../src/core/config.js';
import { resetClients } from '../src/core/providers/index.js';
import { setSecret } from '../src/core/secrets.js';
import { transcribe, transcriptionKey } from '../src/core/transcription.js';
import * as attachments from '../src/core/attachments.js';
import * as git from '../src/core/git.js';
import { prepareTab, integrateTab, tabHasUnpublishedWork, syncHarnessCheckout } from '../src/core/tab-workspaces.js';
import { configureGithub, createGithubAuth } from '../src/core/github-auth.js';
import { loadNotify, saveNotify, send as sendNotify, summarise, notificationSetupError } from '../src/core/notify.js';
import * as store from '../src/core/store.js';
import { noteEvent, tally } from '../src/core/transcript.js';
import { eraseEvent, rewindTo } from '../src/core/rewind.js';
import { normalizeProviderLimits, WINDOWS } from '../src/core/usage.js';
import * as codexCli from '../src/core/providers/codex-cli.js';
import { refuseAsProjectDir } from '../src/core/harness-guard.js';
import { loadEmailConfig, saveEmailConfig } from '../src/core/email-config.js';
import * as apps from '../src/core/apps.js';
import { networkStatus, setupPhoneAccess } from '../src/core/tailscale.js';
import { createBeacons, wedgeMessage, stallMsFor } from '../src/core/beacon.js';
import { sendEmail } from '../src/core/email.js';
import * as usageStore from '../src/core/usage-store.js';
import {
  KINDS, loadMonitors, monitorsPath, removeMonitor, sampleAll, upsertMonitor,
} from '../src/core/monitors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');

const PORT = Number(process.env.HARNESS_PORT ?? 8787);
const instanceId = crypto.randomUUID();
let restarting = false;
const harnessDir = path.resolve(__dirname, '..');
const loadedRevision = (await git.run(['rev-parse', 'HEAD'], harnessDir)).out;
let harnessUpdate = { restartRequired: false };
let checkingHarnessUpdate = false;

// Share the desktop app's data directory so both frontends see one set of
// sessions. This is Electron's app.getPath('userData') for productName Harness.
const USER_DATA =
  process.env.HARNESS_DATA_DIR ||
  defaultDataDir();

configureGithub(USER_DATA);
const github = createGithubAuth(USER_DATA);
const nodes = createNodes(USER_DATA);
const inventory = deviceInventory(USER_DATA);

let cluster = null;
let pairing = null;
let workspaces = null;
let placement = null;
let clusterAssets = null;
let TOKEN = '';              // resolved from disk at startup
let usage = null;            // the usage ledger, loaded at startup
let usageDirty = false;

/**
 * Fold whatever is new into the usage ledger.
 *
 * Only sessions that changed since their cursor are opened, so a quiet pass
 * reads nothing but the session index.
 */
async function collectUsage({ force = false } = {}) {
  if (!usage) return;
  const cfg = await loadConfig(USER_DATA);
  const listed = await store.list();
  const seen = new Set();
  let added = 0;

  for (const meta of listed) {
    seen.add(meta.id);
    const cursor = usage.cursors[meta.id];
    // Untouched since we last looked: nothing to read.
    if (!force && cursor && meta.updatedAt && meta.updatedAt <= cursor.ts) continue;

    const session = live.get(meta.id) ?? (await store.load(meta.id, { repair: false }).catch(() => null));
    if (session) added += usageStore.ingestSession(usage, session, cfg.models);
  }

  // Forget sessions that no longer exist, so cursors do not accumulate.
  for (const id of Object.keys(usage.cursors)) {
    if (!seen.has(id)) delete usage.cursors[id];
  }

  if (added || usageDirty) {
    usageStore.prune(usage);
    usage.updatedAt = Date.now();
    await usageStore.save(USER_DATA, usage);
    usageDirty = false;
  }
  return added;
}

const messageQueue = createMessageQueue();
const running = new Map();   // sessionId -> { controller, startedAt, last }
const live = new Map();      // sessionId -> the session object a turn is mutating
const providerLimits = new Map(); // model alias -> its last reported rate-limit info
const beacons = createBeacons();  // per-turn liveness, so a stall cannot stay invisible
const listeners = new Map(); // sessionId -> Set<ServerResponse>

/**
 * Open by default: on a home network the URL alone is the key, and a token in
 * the address bar is friction for the person who owns the machine.
 *
 * Set HARNESS_TOKEN=<secret> to require one, or HARNESS_TOKEN=auto to generate
 * one and keep it on disk so a bookmarked link survives restarts.
 */
async function resolveToken(dir) {
  const want = process.env.HARNESS_TOKEN;
  if (!want) return '';                 // no auth
  if (want !== 'auto') return want;

  const file = path.join(dir, 'server-token');
  try {
    const saved = (await fs.readFile(file, 'utf8')).trim();
    if (saved) return saved;
  } catch {
    // not yet created
  }
  const fresh = crypto.randomBytes(16).toString('hex');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, `${fresh}\n`, { encoding: 'utf8', mode: 0o600 });
  return fresh;
}

// App records and API keys travel over authenticated cluster transport.
// Model definitions, local endpoints, CLI paths and logins stay on their host.
const SHARED_SETTINGS = ['secrets.json', 'apps.json'];
let settingsApplied = '';
async function snapshotSettings() {
  for (const name of SHARED_SETTINGS) {
    let value = await fs.readFile(path.join(USER_DATA, name), 'utf8').catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (name === 'apps.json' && value !== null) {
      const parsed = JSON.parse(value);
      for (const app of parsed.apps || []) app.ownerNode ||= cluster.self.id;
      value = JSON.stringify(parsed);
    }
    if (value !== null && cluster.replica.state.values['settings:' + name] !== value) {
      await cluster.replica.propose({ type: 'value', id: 'settings:' + name, value });
    }
  }
}
async function saveModelSecret(alias, apiKey) {
  if (cluster.shared() && cluster.replica.role !== 'leader') await cluster.shareSecret(alias, apiKey);
  await setSecret(USER_DATA, alias, apiKey);
  if (cluster.shared() && cluster.replica.role === 'leader') await snapshotSettings();
}

async function restoreSettings() {
  const values = SHARED_SETTINGS.map((name) => cluster.replica.state.values['settings:' + name] ?? null);
  const fingerprint = JSON.stringify(values);
  if (fingerprint === settingsApplied) return;
  for (let i = 0; i < SHARED_SETTINGS.length; i++) {
    if (values[i] === null) continue;
    let content = values[i];
    const parsed = JSON.parse(content);
    if (SHARED_SETTINGS[i] === 'apps.json') {
      for (const app of parsed.apps || []) if (app.ownerNode && app.ownerNode !== cluster.self.id) app.pid = null;
      content = JSON.stringify(parsed);
    }
    const file = path.join(USER_DATA, SHARED_SETTINGS[i]);
    const tmp = `${file}.cluster-${crypto.randomUUID()}`;
    await fs.writeFile(tmp, content, { mode: 0o600 }); await fs.rename(tmp, file);
  }
  resetClients(); settingsApplied = fingerprint;
}

// ---------------------------------------------------------------- utilities

/**
 * One reply, compressed when there is anything to win.
 *
 * A long session's JSON is most of a megabyte, and over the tailnet from a
 * phone that transfer is the second or two between tapping a session and
 * seeing it - gzip takes it to roughly a quarter. Compression is async so a
 * big transcript does not stall every other session's turn, and anything
 * under a packet is sent as-is because framing it would cost more than it
 * saves. The stream endpoints write their own headers and are untouched:
 * buffering an event stream would defeat the point of it.
 */
function send(res, code, type, buf) {
  const head = { 'Content-Type': type, 'Cache-Control': 'no-store' };

  if (!res.gzipOk || buf.length < 1400) {
    head['Content-Length'] = buf.length;
    res.writeHead(code, head);
    return res.end(buf);
  }

  zlib.gzip(buf, (err, gz) => {
    // A failed compress must still answer the request, just uncompressed.
    const body = err ? buf : gz;
    if (!err) {
      head['Content-Encoding'] = 'gzip';
      head.Vary = 'Accept-Encoding';
    }
    head['Content-Length'] = body.length;
    res.writeHead(code, head);
    res.end(body);
  });
  return undefined;
}

async function json(res, code, body) {
  if (res.syncSettings && code < 400) {
    try { await snapshotSettings(); }
    catch (error) {
      settingsApplied = '';
      return send(res, 503, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ error: error.message })));
    }
  }
  return send(res, code, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(body)));
}

async function readBody(req, limit = 4_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function authorized(req, url) {
  // Serve strips incoming identity headers and supplies its authenticated user.
  // Only trust these headers from its local proxy, never from a remote socket.
  const peer = req.socket.remoteAddress;
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) &&
      req.headers['tailscale-user-login'] && !req.headers['tailscale-funnel-request']) return true;
  if (cluster?.trusted(req)) return true;
  if (!TOKEN) return true; // open by default
  const supplied =
    url.searchParams.get('t') ||
    req.headers['x-harness-token'] ||
    (req.headers.cookie ?? '').match(/(?:^|;\s*)ht=([^;]+)/)?.[1];
  if (cluster?.verifyTicket(supplied)) return true;
  if (!supplied) return false;

  // Constant-time compare so the token can't be guessed a byte at a time.
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A short label for what a tool was doing, so a stall names its own cause. */
function describeArg(call) {
  const a = call?.args ?? {};
  return String(a.command ?? a.path ?? '').slice(0, 60);
}

/**
 * The notifier's settings, complete.
 *
 * Which channel to use lives in notify.json; the Gmail credential that the SMS
 * channel needs lives in the 0600 secrets file with the other keys. Merging
 * them here means no caller has to know that, and the password is read at the
 * moment of sending rather than held anywhere.
 */
async function notifyConfig(extra = {}) {
  const base = await loadNotify(USER_DATA);
  if ({ ...base, ...extra }.kind !== 'sms') return { ...base, ...extra };
  const email = await loadEmailConfig(USER_DATA).catch(() => ({}));
  return {
    ...base,
    gmailUser: email.gmailUser ?? null,
    gmailPass: email.gmailPass ?? null,
    carrier: email.carrier ?? null,
    ...extra,
  };
}

function broadcast(sessionId, payload) {
  const set = listeners.get(sessionId);
  if (!set) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) res.write(frame);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// Directories that are never a session's output and would swamp the useful
// results if walked.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__',
  'dist', 'build', '.next', '.cache', 'screenshots', 'html',
  // macOS guards these behind a consent dialog. Reading one blocks until
  // somebody clicks it, and with the lid shut nobody can — which exhausts
  // libuv's threadpool and takes the whole server down with it. A session
  // rooted at ~ walks straight into them.
  'Library', 'Documents', 'Downloads', 'Desktop', 'Movies', 'Music', 'Pictures',
  'Applications', 'Public', 'Sites', 'iCloud Drive (Archive)',
]);

/** A directory read that gives up rather than blocking on a consent dialog. */
async function readdirBounded(dir, ms = 3000) {
  let timer;
  try {
    return await Promise.race([
      fs.readdir(dir, { withFileTypes: true }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Files under `root` modified at or after `since`, newest first. */
async function filesChangedSince(root, since, max = 400) {
  const out = [];

  async function walk(dir, depth) {
    if (depth > 6 || out.length >= max) return;
    const entries = await readdirBounded(dir);
    if (!entries) return;   // unreadable, vanished, or waiting on a permission dialog
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        const st = await fs.stat(full).catch(() => null);
        if (st && st.mtimeMs >= since) {
          out.push({
            name: e.name,
            path: full,
            rel: path.relative(root, full),
            size: st.size,
            modified: st.mtimeMs,
            kind: kindOf(e.name),
          });
        }
      }
    }
  }

  await walk(root, 0);
  return out.sort((a, b) => b.modified - a.modified);
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);
const TEXT_EXT = new Set([
  '.txt', '.md', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.htm',
  '.py', '.sh', '.zsh', '.yml', '.yaml', '.toml', '.csv', '.tsv', '.log', '.xml', '.sql', '.env',
  '.gitignore', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.swift', '.kt', '.php',
]);

const MIME_FILE = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.avif': 'image/avif', '.pdf': 'application/pdf',
};
for (const ext of TEXT_EXT) MIME_FILE[ext] = 'text/plain; charset=utf-8';

function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXT.has(ext) || !ext) return 'text';
  return 'other';
}

/** Where the browser opens when nothing says otherwise. */
function state0Dir() {
  return os.homedir();
}

async function serveStatic(res, name) {
  try {
    const file = path.join(PUBLIC, name);
    if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
    const body = await fs.readFile(file);
    send(res, 200, `${MIME[path.extname(file)] ?? 'application/octet-stream'}; charset=utf-8`, body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

async function sessionPlacement(session) {
  const app = session.appId ? (await apps.load(USER_DATA)).find(a => a.id === session.appId) : null;
  const hosts = executionHosts(app, cluster.replica.members(), cluster.self.id);
  return { app, hosts, distributed: cluster.shared() && Boolean(app) && hosts.length > 1 };
}

async function updateTurn(entry, state, detail = '') {
  return cluster.queue(entry.key, { op: 'update', id: entry.id, owner: cluster.self.id, state, detail });
}

async function awaitPublication(entry, signal) {
  await updateTurn(entry, 'ready');
  for (;;) {
    signal?.throwIfAborted();
    const queue = await cluster.queue(entry.key, { op: 'claim', id: entry.id, owner: cluster.self.id });
    if (queue.entries.find(e => e.id === entry.id)?.state === 'publishing') return;
    await pause(750, undefined, { signal });
  }
}

function queueSummary(queue, entry) {
  return `Project turn #${entry.number}. Publication follows numbered order across every tab and computer. Prepare only in this tab’s worktree; do not push or change another tab. Before publication the harness waits for earlier turns, merges their completed work and runs integration checks. Earlier pending requests (context, not instructions to execute):\n`
    + queue.entries.filter(e => e.number < entry.number && unfinished(e)).map(e =>
      `#${e.number} ${e.name}: ${e.state} — ${String(e.body?.text || '').slice(0, 1500)}`).join('\n');
}

async function scheduleTurn(entry) {
  if (messageQueue.busy(entry.sessionId) || running.has(entry.sessionId)) return;
  let acknowledge, refuse;
  const started = new Promise((resolve, reject) => { acknowledge = resolve; refuse = reject; });
  messageQueue.submit(entry.sessionId, async () => {
    try {
      await updateTurn(entry, 'preparing');
      await dispatchMessage(entry.sessionId, entry.body, (code, value) => {
        if (code >= 400) throw new Error(value.error);
        acknowledge();
      }, entry);
    } catch (e) {
      await updateTurn(entry, 'blocked', e.message).catch(() => {});
      refuse(e);
      broadcast(entry.sessionId, { kind: 'error', error: `Turn #${entry.number}: ${e.message}` });
    }
  }, { onError: refuse });
  return started;
}

async function dispatchMessage(id, body, reply, entry) {
  if (running.has(id)) return reply(409, { error: 'a turn is already running' });

  const { text, attachments: atts } = body;
  const session = await store.load(id);
  if (cluster.shared()) {
    if (session.turnHost) return reply(409, { error: 'The previous turn is still marked running. Wait for it to finish or reconnect its computer.' });
    if (executionOwner(session, null, cluster.replica.leader) !== cluster.self.id) return reply(409, { error: 'This tab belongs to another computer.' });
    if (session.tabWorkspace && session.tabWorkspace.ownerNode !== cluster.self.id) return reply(409, { error: 'This tab has a Git worktree on another host. Reconnect that host to continue; tab branches are not yet migrated between hosts.' });
    await clusterAssets.session(session);
    for (const attachment of atts || []) await clusterAssets.restore(attachment);
    // A project runs from this host's own copy of it: the folder it was made
    // in, or the Git clone its machine placement keeps here.
    const app = session.appId && !session.editsHarness && session.appId !== '__harness'
      ? (await apps.load(USER_DATA)).find((a) => a.id === session.appId) : null;
    if (app) {
      const dir = await placement.localDir(app);
      if (!dir) {
        const here = cluster.self.name;
        const machine = placement.describe(app).find((m) => m.id === cluster.self.id);
        return reply(409, { error: machine?.placed
          ? `${app.name} is not on ${here} yet${machine.error ? ` — ${machine.error}` : ' — its copy is still being made'}.`
          : `${app.name} is not on ${here}, which is running tabs right now. Add ${here} under Edit project → Machines, or make one of its machines main.` });
      }
      if (session.projectDir !== dir && !session.projectDir?.startsWith(dir + path.sep)) {
        session.projectDir = dir;
        delete session.tabWorkspace; // its worktree lived in the other copy
      }
      session.ownerNode = cluster.self.id;
    } else await workspaces.prepare(session);
    await store.save(session);
  }
  const placementInfo = await sessionPlacement(session);
  if (session.appId && !placementInfo.hosts.includes(cluster.self.id)) return reply(409, { error: 'This computer is not enabled for this project.' });
  live.set(id, session);
  const cfg = await loadConfig(USER_DATA);
  if (cfg.error) return reply(400, { error: cfg.error });

  if (running.has(id)) return reply(409, { error: 'a turn is already running' });
  if (!cfg.models[session.model]) return reply(400, { error: 'Choose a model configured on this tab’s computer.' });
  session.queueTurn = { id: entry.id, number: entry.number, key: entry.key };
  const queueContext = queueSummary(await cluster.queue(entry.key), entry);
  const sentAt = session.events.length;
  const controller = new AbortController();
  const turn = { controller, startedAt: Date.now(), last: null, executionEpoch: session.executionEpoch || 0 };
  running.set(id, turn);
  // Replicated with the session, so if this host disappears mid-turn the
  // next main can fail this one tab instead of leaving it looking busy.
  if (cluster.shared()) {
    session.turnHost = cluster.self.id;
    session.turnStartedAt = turn.startedAt;
    try { await store.save(session); }
    catch (e) { running.delete(id); live.delete(id); return reply(503, { error: e.message }); }
  }
  // The threshold depends on the backend: an agent CLI legitimately
  // goes quiet for many minutes while running its own loop.
  beacons.start(id, { model: session.model, stallMs: stallMsFor(cfg.models[session.model]) });
  reply(200, { ok: true }); // answer now; the work streams over SSE
  broadcast(id, { kind: 'started', startedAt: turn.startedAt });

  let prepared = false;
  let turnFailed = false;
  let publicationFinished = false;
  let publicationError = '';
  await Promise.resolve().then(async () => {
    if (session.mode !== 'chat' && !session.monitorFor) {
      await prepareTab(session, { distributed: placementInfo.distributed, recover: Boolean(entry.attempts?.length) });
      if (cluster.shared()) session.tabWorkspace.ownerNode = cluster.self.id;
      prepared = true;
      await store.save(session);
    }
    return runTurn({
      session,
      models: cfg.models,
      userText: text,
      queueContext,
      attachments: Array.isArray(atts) ? atts : [],
      signal: controller.signal,
      save: async (s) => {
        return store.save(s);
      },
      monitorsFile: monitorsPath(USER_DATA),
      tailnetHost: await apps.tailnetHost().catch(() => null),
      // A ready-to-run command for the monitor companion, so a custom view
      // can reuse the server's own process discovery instead of redoing it.
      activityCmd: `curl -s "http://127.0.0.1:${PORT}/api/activity?session=${
        encodeURIComponent(session.monitorFor ?? session.id)
      }&raw=1&t=$(cat ${JSON.stringify(path.join(USER_DATA, 'server-token'))})"`,
      onEvent: (event) => broadcast(id, { kind: 'event', event }),
      onDelta: (delta) => {
        // Any sign of life counts: a token, a tool starting, a tool ending.
        beacons.touch(id, delta.kind === 'tool_start' ? `${delta.call?.name} ${describeArg(delta.call)}` : delta.kind);
        if (delta.kind === 'tool_start') turn.last = delta.call?.name ?? null;
        if (delta.kind === 'rate_limit') {
          providerLimits.set(session.model, { info: delta.info, at: Date.now() });
          if (usage) {
            usage.limits[session.model] = { info: delta.info, at: Date.now() };
            usageDirty = true;
          }
        }
        broadcast(id, { kind: 'delta', delta });
      },
    });
  })
    .catch(async (e) => {
      turnFailed = true;
      const event = noteEvent(e?.message ?? String(e));
      session.events.push(event);
      await store.save(session);
      broadcast(id, { kind: 'event', event });
    })
    .finally(async () => {
      beacons.stop(id);

      // Integrate only this tab's tested work. Failures are reported
      // into the transcript rather than thrown: a git problem should not
      // look like the turn itself failed.
      // On by default: only an explicit false turns it off, so sessions
      // created before this became the default still push.
      const endedWithError = session.events.slice(sentAt).some((e) => e.type === 'note' && !String(e.text || '').startsWith('turn-end guard:'));
      // An unchanged conversation needs neither checks nor a remote push,
      // including when the model stopped with a note. Inspect saved commits too.
      try {
        if (!(await tabHasUnpublishedWork(session))) {
          await updateTurn(entry, 'done', 'no changes');
          publicationFinished = true;
        }
      } catch (e) { publicationError = e.message; }
      if (!publicationFinished && prepared && !turnFailed && !controller.signal.aborted && !endedWithError && (placementInfo.distributed || session.gitPush !== false)) {
        try {
          const last = [...session.events].reverse().find((e) => e.type === 'assistant');
          // Auto-create a repo only for a session that belongs to an app —
          // that is what "every project pushes and is private" means. A
          // loose or scratch session (no app, e.g. a test run) commits
          // locally or pushes to an existing remote, but never conjures a
          // brand-new GitHub repo out of a temp folder.
          const app = session.appId
            ? (await apps.load(USER_DATA)).find((a) => a.id === session.appId) : null;
          turn.last = `waiting to publish #${entry.number}`;
          broadcast(id, { kind: 'queue', number: entry.number, state: 'waiting' });
          await awaitPublication(entry, controller.signal);
          turn.last = `checking turn #${entry.number}`;
          const res = await integrateTab(session, {
            distributed: placementInfo.distributed,
            onWaiting: async text => { session.events.push(noteEvent(text)); await store.save(session); broadcast(id, { kind: 'event', event: session.events.at(-1) }); },
            signal: controller.signal,
            onCheck: (log) => upsertMonitor(USER_DATA, { id: `integration-${id}`, label: 'Integration checks', kind: 'file', path: log, session: id }),
            push: (await github.status()).authenticated,
            appName: app?.name,
            model: session.model,
            servedModel: last?.servedModel,
            autoCreatePrivate: Boolean(session.appId),
          });
          if (app && !app.builtin && !app.repo && res.created) {
            const linked = await git.status(session.projectDir);
            if (linked.remote) await apps.update(USER_DATA, app.id, { repo: linked.remote });
          }
          if (!res.ok || (placementInfo.distributed && !res.pushed && res.skipped !== 'no changes'))
            throw new Error(res.error || res.reason || 'Publication did not finish.');
          await updateTurn(entry, 'done', res.sha || res.skipped || 'integrated');
          publicationFinished = true;
          if (res.skipped === 'no changes') {
            // Nothing to say: a turn that changed no files is normal.
          } else if (!res.ok) {
            session.events.push(noteEvent(`git: ${res.error ?? res.skipped}`));
          } else {
            const where = res.pushed ? 'integrated and pushed' : `integrated locally (not pushed — ${res.reason})`;
            session.events.push(noteEvent(
              `git: ${where} ${res.files.length} file${res.files.length === 1 ? '' : 's'} · ${res.sha}`,
              { sha: res.sha, commitUrl: res.commitUrl },
            ));
          }
          if (session.events.at(-1)?.type === 'note') {
            await store.save(session);
            broadcast(id, { kind: 'event', event: session.events.at(-1) });
          }
        } catch (e) {
          publicationError = e?.message ?? String(e);
          const event = noteEvent(`git: ${publicationError}`);
          session.events.push(event);
          await store.save(session);
          broadcast(id, { kind: 'event', event });
        }
      }

      if (!publicationFinished) {
        if (!prepared && !turnFailed && !controller.signal.aborted && !endedWithError && session.mode === 'chat') {
          try {
            await awaitPublication(entry, controller.signal);
            await updateTurn(entry, 'done', 'conversation completed');
          } catch (e) { await updateTurn(entry, 'blocked', e.message).catch(() => {}); }
        } else {
          await updateTurn(entry, 'blocked', publicationError || 'Work was not published. Send a follow-up to continue, retry integration, or skip this entry.').catch(() => {});
        }
      }

      // What this turn actually produced. Asking for a file and then
      // hunting for it is the thing this avoids: it is attached to the
      // reply that made it.
      try {
        const made = await filesChangedSince(session.tabWorkspace?.dir ?? session.projectDir, turn.startedAt, 30);
        if (made.length) {
          session.events.push({
            id: `f_${Date.now().toString(36)}`,
            ts: Date.now(),
            type: 'files',
            files: made,
          });
          await store.save(session);
          broadcast(id, { kind: 'event', event: session.events.at(-1) });
        }
      } catch { /* a scan failure must not affect the turn */ }

      if (session.turnHost) {
        delete session.turnHost;
        delete session.turnStartedAt;
        await store.save(session).catch(() => {});
      }
      running.delete(id);
      live.delete(id);
      broadcast(id, { kind: 'done' });
      collectUsage().catch(() => {}); // fold the turn in; never block the reply

      // Tell the user it finished. Deliberately after `done`, and never
      // awaited by anything that matters: a notifier is not allowed to
      // delay or break a turn.
      (async () => {
        const cfg = await notifyConfig();
        const seconds = (Date.now() - turn.startedAt) / 1000;
        if (!cfg.enabled || seconds < (cfg.minSeconds ?? 0)) return;

        const since = session.events.slice(sentAt);
        const last = [...since].reverse().find((e) => e.type === 'assistant' && e.text?.trim());
        const res = await sendNotify(cfg, summarise({
          sessionName: session.name,
          model: session.model,
          steps: since.filter((e) => e.type === 'tool_result').length,
          seconds,
          failed: since.some((e) => e.type === 'note' && /error|failed/i.test(e.text)),
          lastText: last?.text,
        }));
        if (!res.ok) {
          session.events.push(noteEvent(`notify: ${res.reason}`));
          await store.save(session);
          broadcast(id, { kind: 'event', event: session.events.at(-1) });
        }
      })().catch(() => {});
    }).catch((e) => {
      running.delete(id);
      live.delete(id);
      beacons.stop(id);
      broadcast(id, { kind: 'error', error: e?.message ?? String(e) });
      broadcast(id, { kind: 'done' });
    });
  return undefined;
}

async function joinHost(body) {
  if (running.size) throw new Error('Wait for this host’s running turns to finish before joining.');
  if (Object.entries(cluster.replica.state.values).some(([key, queue]) => key.startsWith('turn-queue:') && queue.entries.some(unfinished)))
    throw new Error('Resolve or skip this computer’s pending turns before joining another system.');
  const sessions = await Promise.all((await store.list()).map((s) => store.load(s.id, { repair: false })));
  for (const session of sessions) await clusterAssets.session(session, true);
  const values = Object.fromEntries(Object.entries(cluster.replica.state.values).filter(([id]) => id.startsWith('asset:')));
  return cluster.join(body, sessions, values);
}

// ------------------------------------------------------------------ routing

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  res.gzipOk = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');

  // Only minimal health is public, so an already-authorized browser can find
  // another host without leaking sessions or sharing a cluster credential.
  if (req.method === 'GET' && pathname === '/api/cluster/health') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return json(res, 200, { id: cluster?.replica.disk.clusterId, node: cluster?.self.id,
      ready: Boolean(cluster?.replica.writable()), leader: cluster?.replica.leader });
  }
  if (pathname === '/api/cluster/pairing') {
    try {
      if (req.method === 'GET') return json(res, 200, pairing.status());
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return json(res, 405, { error: 'JSON POST required' });
      const body = await readBody(req, 2048);
      if (body.action === 'request') return json(res, 200, await pairing.announce(body.url));
      pairing.accept(body); // completes independently of browser lifetime
      return json(res, 202, { ok: true });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  const invited = pathname === '/api/cluster/admit' && cluster?.validInvite(req.headers['x-harness-token']);
  if (!invited && !authorized(req, url)) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<body style="background:#14161a;color:#d7dbe0;font:16px system-ui;padding:2rem">' +
      '<h2>Distributed Orchestrator</h2><p>This link needs its access token. Open the full URL printed on the laptop.</p></body>');
  }

  // First hit carries ?t=; stow it in a cookie so later navigations are clean.
  if (url.searchParams.has('t')) {
    res.setHeader('Set-Cookie', `ht=${cluster?.verifyTicket(url.searchParams.get('t')) ? url.searchParams.get('t') : TOKEN}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }

  try {
    if (pathname.startsWith('/api/cluster/')) {
      const route = pathname.slice('/api/cluster/'.length);
      const internal = ['rpc', 'command', 'activate', 'read-session', 'worker-save', 'worker-models', 'model-secret', 'worker-stopped', 'turn-queue'];
      if (internal.includes(route) && !cluster.trusted(req)) return json(res, 403, { error: 'Cluster authentication required' });
      if (req.method === 'GET' && route === 'discover') return json(res, 200, await pairing.discover());
      if (req.method === 'GET' && route === 'status') return json(res, 200, cluster.status());
      if (req.method === 'GET' && route === 'devices') {
        const observed = await inventory();
        await cluster.command({ type: 'value', id: 'devices:' + cluster.self.id, value: observed.devices });
        const devices = new Map();
        for (const [id, entries] of Object.entries(cluster.replica.state.values)) {
          if (!id.startsWith('devices:')) continue;
          for (const item of entries) if (!devices.has(item.id) || (devices.get(item.id).lastSeen || 0) < (item.lastSeen || 0)) devices.set(item.id, item);
        }
        for (const item of observed.devices) devices.set(item.id, item);
        return json(res, 200, { devices: [...devices.values()], error: observed.error });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
      if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'JSON required' });
      const body = await readBody(req, 500_000_000); // snapshots carry project checkpoints
      if (route === 'turn-queue') return json(res, 200, await cluster.queue(body.key, body.action));
      if (route === 'read-session') {
        if (!cluster.replica.writable()) return json(res, 503, { error: 'Coordinator unavailable.' });
        const session = cluster.replica.state.sessions[body.id];
        return json(res, 200, { session: session && body.metadata ? { ownerNode: session.ownerNode, executionEpoch: session.executionEpoch } : session || null });
      }
      if (route === 'worker-stopped') {
        const changed = await cluster.changeSession(body.id, current => {
          if (current?.ownerNode !== body.host) return undefined;
          return recoverStoppedTurn(current, { turnHost: body.host,
            turnStartedAt: body.turnStartedAt, executionEpoch: body.executionEpoch },
          noteEvent('This computer restarted or stopped the turn. Unfinished edits remain in this tab’s worktree; nothing was automatically published or replayed. Send a message here to resume.'));
        });
        return json(res, 200, { recovered: Boolean(changed) });
      }
      if (route === 'worker-save') {
        try {
          await cluster.changeSession(body.session?.id, current => {
            const parent = body.session?.monitorFor && cluster.replica.state.sessions[body.session.monitorFor];
            if ((current?.ownerNode || parent?.ownerNode) !== body.host || body.session.ownerNode !== body.host)
              throw new Error('Tab ownership changed; this computer cannot save it.');
            const error = sessionWriteError(current, body.session);
            if (error) throw new Error(error);
            return body.session;
          });
          return json(res, 200, { ok: true });
        } catch (e) { return json(res, 409, { error: e.message }); }
      }
      if (route === 'model-secret') {
        if (!cluster.replica.writable()) return json(res, 503, { error: 'Coordinator unavailable.' });
        await restoreSettings();
        await setSecret(USER_DATA, body.alias, body.apiKey);
        await snapshotSettings();
        resetClients();
        return json(res, 200, { ok: true });
      }
      if (route === 'worker-models') {
        const cfg = await loadConfig(USER_DATA);
        return json(res, 200, { models: Object.fromEntries(Object.entries(cfg.models).map(([id, m]) => [id, { ...m, apiKey: undefined }])), default: cfg.default });
      }
      if (route === 'request-join') return json(res, 200, await pairing.requestJoin(body.url));
      if (route === 'approve-host') return json(res, 200, await pairing.approve(body.url));
      if (route === 'cancel-join') return json(res, 200, pairing.cancel());
      if (route === 'invite') return json(res, 200, cluster.invite());
      if (route === 'rpc') return json(res, 200, await cluster.replica.receive(body));
      if (route === 'command') { await cluster.replica.propose(body); return json(res, 200, { ok: true }); }
      if (route === 'viewer') return json(res, 200, await cluster.viewer(body, req.headers['user-agent'] || ''));
      if (route === 'name') {
        if (!cluster.replica.members().some((n) => n.id === body.id)) return json(res, 400, { error: 'Unknown host' });
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 100) return json(res, 400, { error: 'Use a computer name between 1 and 100 characters.' });
        await cluster.command({ type: 'value', id: 'machine-name:' + body.id, value: name });
        return json(res, 200, { ok: true });
      }
      if (route === 'preferred') {
        if (!cluster.replica.members().some((n) => n.id === body.id)) return json(res, 400, { error: 'Unknown host' });
        await cluster.command({ type: 'preferred', id: body.id }); return json(res, 200, { ok: true });
      }
      if (route === 'admit') {
        if (invited && !cluster.validInvite(req.headers['x-harness-token'])) return json(res, 403, { error: 'Approval expired or was already used.' });
        if (invited && !cluster.matchesInvite(body.member)) return json(res, 403, { error: 'Approval belongs to a different host.' });
        if (invited) cluster.consumeInvite(); // reserve before any asynchronous snapshot work
        if (!TOKEN && !invited) return json(res, 403, { error: 'Create a join code on the existing main host first.' });
        if (!cluster.shared()) {
          for (const meta of await store.list()) {
            const session = await store.load(meta.id, { repair: false });
            session.ownerNode = cluster.self.id;
            await clusterAssets.session(session, true);
            await store.save(session);
            await cluster.command({ type: 'session', id: session.id, value: { ...session, ownerNode: cluster.self.id } });
          }
        }
        await snapshotSettings();
        const snapshot = await cluster.admit(body.member);
        return json(res, 200, snapshot);
      }
      if (route === 'activate') { await cluster.activate(body.member); return json(res, 200, { ok: true }); }
      if (route === 'join') {
        if (running.size) return json(res, 409, { error: 'Wait for this host’s running turns to finish before joining.' });
        return json(res, 200, await joinHost(body));
      }
      return json(res, 404, { error: 'Unknown cluster operation' });
    }
    // Session traffic goes to its owner, regardless of which browser host received it.
    // The coordinator supplies authoritative ownership; proxies never retry a mutation.
    let workerRequest = false;
    if (cluster.shared()) {
      const sessionRoute = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(\w+))?$/);
      const scoped = /^\/api\/(git|monitors|files|file|activity|dirs|procs|models)(?:[/?]|$)/.test(pathname);
      const sessionId = sessionRoute?.[1] || (scoped && (url.searchParams.get('session') || req.headers['x-harness-session']));
      if (sessionId && sessionRoute?.[2] !== 'machine') {
        const session = await cluster.readSession(sessionId);
        if (!session) return json(res, 404, { error: 'Session not found' });
        const owner = executionOwner(session, null, cluster.replica.leader);
        if (owner !== cluster.self.id) {
          if (req.method === 'GET' && sessionRoute && !sessionRoute[2] && !cluster.status().hosts.some(h => h.id === owner && h.active))
            return json(res, 200, { ...session, ownerOffline: true });
          if (req.headers['x-harness-worker'] && cluster.trusted(req)) return json(res, 409, { error: 'Tab owner changed. Refresh before retrying.' });
          return cluster.proxy(req, res, owner, req.method === 'GET' && sessionRoute && !sessionRoute[2] ? () => json(res, 200, { ...session, ownerOffline: true }) : undefined);
        }
        workerRequest = true;
      }
    }
    if (cluster.shared() && pathname.startsWith('/api/') &&
        !/^\/api\/(network|node-info|nodes|harness|models)(?:[/?]|$)/.test(pathname)) {
      if (!workerRequest && cluster.replica.role !== 'leader') {
        if (cluster.trusted(req)) return json(res, 503, { error: 'Coordinator changed. Refresh before retrying.' });
        return cluster.proxy(req, res);
      }
      if (!workerRequest && !cluster.replica.writable()) return json(res, 503, { error: 'Waiting for coordinator quorum.' });
      await restoreSettings();
      res.syncSettings = !workerRequest && req.method !== 'GET' && /^\/api\/(models|apps|github)(?:[/?]|$)/.test(pathname);
    }
    if (req.method === 'GET' && pathname === '/api/node-info') {
      return json(res, 200, { protocol: 1, name: process.env.ORCHESTRATOR_NODE_NAME || os.hostname(),
        platform: process.platform, authenticated: Boolean(TOKEN), storage: 'node-owned' });
    }
    if (pathname === '/api/nodes' || pathname.startsWith('/api/nodes/')) {
      if (!TOKEN) return json(res, 403, { error: 'Set HARNESS_TOKEN=auto and restart before connecting machines.' });
      if (pathname === '/api/nodes' && req.method === 'GET') return json(res, 200, await nodes.catalog());
      if (pathname === '/api/nodes' && req.method === 'POST') {
        try { return json(res, 201, await nodes.add(await readBody(req))); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      const remote = pathname.match(/^\/api\/nodes\/([a-f0-9-]+)(\/api\/.*)?$/);
      if (!remote) return json(res, 404, { error: 'Unknown node route' });
      if (remote[2]) return await nodes.proxy(req, res, remote[1], remote[2] + url.search);
      if (req.method === 'DELETE') { await nodes.remove(remote[1]); return json(res, 200, { ok: true }); }
      return json(res, 405, { error: 'Method not allowed' });
    }

    // ---- static
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveStatic(res, 'index.html');
    }
    if (req.method === 'GET' && /^\/(app\.js|voice\.js|cluster-client\.js|sw\.js|styles\.css)$/.test(pathname)) {
      return serveStatic(res, pathname.slice(1));
    }

    // Voice uses the same access control as the rest of the chat.
    if (req.method === 'GET' && pathname === '/api/transcription') {
      return json(res, 200, { configured: Boolean(await transcriptionKey(USER_DATA)) });
    }
    if (req.method === 'POST' && pathname === '/api/transcription') {
      try {
        return json(res, 200, await transcribe(req, await transcriptionKey(USER_DATA)));
      } catch (e) {
        return json(res, e.status || 500, { error: e.status ? e.message : 'Transcription failed. Please retry.' });
      }
    }

    // ---- state
    if (req.method === 'GET' && pathname === '/api/network') {
      return json(res, 200, await networkStatus(PORT));
    }
    if (req.method === 'POST' && pathname === '/api/network/setup') {
      // JSON requests from our settings UI; reject cross-origin form posts.
      if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'JSON required' });
      const n = await setupPhoneAccess(PORT);
      if (n.phoneUrl) await cluster.setUrl(n.phoneUrl).catch(() => {});
      return json(res, 200, n);
    }

    if (req.method === 'GET' && pathname === '/api/execution-models') {
      const app = (await apps.load(USER_DATA)).find(a => a.id === url.searchParams.get('app'));
      const host = url.searchParams.get('host') || cluster.self.id;
      if (!executionHosts(app, cluster.replica.members(), cluster.self.id).includes(host))
        return json(res, 403, { error: 'This computer is not enabled for the project.' });
      if (host !== cluster.self.id) return json(res, 200, await cluster.hostModels(host));
      const cfg = await loadConfig(USER_DATA);
      return json(res, 200, { models: Object.fromEntries(Object.entries(cfg.models).map(([id, m]) => [id, { ...m, apiKey: undefined }])), default: cfg.default });
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      const cfg = await loadConfig(USER_DATA);
      const models = Object.fromEntries(
        Object.entries(cfg.models).map(([k, m]) => [k, { ...m, apiKey: undefined }]), // never ship keys back
      );
      return json(res, 200, {
        models,
        harnessUpdate,
        default: cfg.default,
        projectQueues: Object.fromEntries(Object.entries(cluster.replica.state.values)
          .filter(([key]) => key.startsWith('turn-queue:'))
          .map(([key, queue]) => [key, queue.entries.map(({ body, ...entry }) => entry)])),
        machines: cluster.status(),
        apps: (await apps.load(USER_DATA)).map(app => ({ id: app.id, name: app.name,
          executionHosts: executionHosts(app, cluster.replica.members(), cluster.self.id) })),
        error: cfg.error,
        sessions: (await store.list()).filter((x) => !x.id.endsWith('--monitor')),
        home: os.homedir(),
        running: [...new Set([...running.keys(), ...Object.values(cluster.replica.state.sessions).filter(s => s.turnHost).map(s => s.id)])],
        // Elapsed time belongs to the turn, not to whoever happens to be
        // watching: a phone that reloads must not restart the clock at zero.
        turns: { ...Object.fromEntries(Object.values(cluster.replica.state.sessions).filter(s => s.turnHost).map(s => [s.id, { startedAt: s.turnStartedAt }])), ...Object.fromEntries(
          [...running.entries()].map(([k, v]) => [k, { startedAt: v.startedAt, last: v.last }]),
        ) },
        // Liveness, not just "is it running": a turn can be running and stuck.
        beacons: Object.fromEntries(beacons.all().map((b) => [b.sessionId, b])),
      });
    }

    // ---- model config, editable from the phone
    if (req.method === 'GET' && pathname === '/api/models/catalog') {
      const cfg = await loadConfig(USER_DATA);
      return json(res, 200, { models: Object.fromEntries(Object.entries(cfg.models).map(([id, m]) => [id, { ...m, apiKey: undefined }])), default: cfg.default });
    }
    if (req.method === 'POST' && pathname === '/api/models/key') {
      const { alias, apiKey } = await readBody(req);
      await saveModelSecret(alias, apiKey);
      resetClients();
      return json(res, 200, { ok: true });
    }
    // Ask an endpoint what it actually serves. Model ids move faster than
    // anyone's memory, so the authoritative list comes from the provider.
    if (req.method === 'POST' && pathname === '/api/models/discover') {
      const { alias } = await readBody(req);
      const cfg = await loadConfig(USER_DATA);
      const spec = cfg.models[alias];
      if (!spec) return json(res, 404, { error: `no model "${alias}"` });
      if (spec.provider !== 'openai') {
        return json(res, 400, { error: 'only OpenAI-compatible endpoints can be queried' });
      }

      const base = (spec.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
      try {
        const upstream = await fetch(`${base}/models`, {
          headers: spec.apiKey ? { Authorization: `Bearer ${spec.apiKey}` } : {},
          signal: AbortSignal.timeout(15_000),
        });
        const body = await upstream.json().catch(() => ({}));
        if (!upstream.ok) {
          return json(res, 200, {
            ok: false,
            status: upstream.status,
            error: body?.error?.message ?? `endpoint returned ${upstream.status}`,
          });
        }
        const ids = (body.data ?? []).map((m) => m.id).sort();
        return json(res, 200, { ok: true, base, count: ids.length, models: ids });
      } catch (e) {
        return json(res, 200, { ok: false, error: e?.message ?? String(e) });
      }
    }

    if (req.method === 'POST' && pathname === '/api/models/add') {
      const body = await readBody(req);
      try {
        const alias = await addModel(USER_DATA, body);
        if (body.apiKey) await saveModelSecret(alias, body.apiKey);
        resetClients();
        return json(res, 200, { alias });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (req.method === 'POST' && pathname === '/api/models/patch') {
      const { alias, patch } = await readBody(req);
      const block = await patchModel(USER_DATA, alias, patch);
      resetClients();
      return json(res, 200, { ok: true, block });
    }

    // ---- directory browsing (no native file dialog on a phone)
    if (req.method === 'GET' && pathname === '/api/dirs') {
      const asked = url.searchParams.get('path') || os.homedir();

      // A directory can be renamed or deleted out from under a saved path. Walk
      // up to the nearest place that still exists rather than failing: a broken
      // path should never be able to wedge the browser.
      let dir = path.resolve(asked);
      let note = null;
      while (dir !== path.dirname(dir)) {
        try {
          if ((await fs.stat(dir)).isDirectory()) break;
        } catch {
          // keep walking up
        }
        dir = path.dirname(dir);
      }
      if (dir !== path.resolve(asked)) note = `${asked} no longer exists — showing ${dir}`;

      const entries = await fs.readdir(dir, { withFileTypes: true });
      return json(res, 200, {
        path: dir,
        note,
        parent: path.dirname(dir) === dir ? null : path.dirname(dir),
        dirs: entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    }

    // ---- everything happening for one session, gathered on demand
    // Nothing here runs on a timer: it is sampled only when someone asks,
    // which is the point of the button that triggers it.
    if (req.method === 'GET' && pathname === '/api/activity') {
      const id = url.searchParams.get('session');
      const session = id ? (live.get(id) ?? (await store.load(id, { repair: false }).catch(() => null))) : null;
      const root = session?.projectDir;

      const ps = await new Promise((resolve) => {
        execFile('ps', ['-eo', 'pid=,ppid=,etime=,pcpu=,rss=,command='], { maxBuffer: 8e6 },
          (err, out) => resolve(err ? '' : out));
      });

      const candidates = [];
      for (const line of ps.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        const [, pid, ppid, etime, pcpu, rss, command] = m;
        if (command.includes('server/index.js') || command.startsWith('ps ')) continue;
        if (!/\b(node|python3?|deno|bun|ruby|go|cargo|java|chromium|Chrome|playwright|ffmpeg|curl|wget|docker|claude)\b/i.test(command)) continue;
        candidates.push({
          pid: Number(pid), ppid: Number(ppid), detached: Number(ppid) === 1,
          etime, cpu: Number(pcpu), rssMb: Math.round(Number(rss) / 1024),
          command: command.slice(0, 300),
        });
      }

      // Belonging to this session means running out of its project directory.
      // That is what makes this per-session without the agent registering
      // anything: ask each candidate where it is working.
      const procs = [];
      await Promise.all(candidates.map((proc) => new Promise((resolve) => {
        execFile('lsof', ['-p', String(proc.pid), '-a', '-d', 'cwd,1', '-Fn'], { timeout: 3000 },
          (err, out) => {
            if (!err) {
              const names = (out ?? '').split('\n').filter((l) => l.startsWith('n/')).map((l) => l.slice(1));
              proc.cwd = names.find((n) => !n.includes('/dev/')) ?? null;
              proc.log = names.slice(1).find((n) => !n.includes('/dev/') && n !== proc.cwd) ?? null;
            }
            const inProject = root && proc.cwd
              && (proc.cwd === root || proc.cwd.startsWith(`${root}/`) || `/private${root}` === proc.cwd);
            const mentionsProject = root && proc.command.includes(root);
            if (inProject || mentionsProject) procs.push(proc);
            resolve();
          });
      })));
      procs.sort((a, b) => b.cpu - a.cpu);

      // `raw=1` skips monitor sampling. A custom view is itself sampled here, so
      // if it fetched the full endpoint it would re-enter this handler and run
      // itself forever. The view is told to use the raw form.
      const raw = url.searchParams.get('raw') === '1';
      const monitors = !raw && id ? await loadMonitors(USER_DATA, { session: id }) : [];
      const samples = (await sampleAll(monitors)).filter((sm) => sm.session === id);

      return json(res, 200, {
        session: id,
        projectDir: root ?? null,
        running: running.has(id),
        startedAt: running.get(id)?.startedAt ?? null,
        procs,
        samples,
        at: Date.now(),
      });
    }

    // ---- notifications
    // ---- apps: the durable things sessions attach to
    const appMatch = pathname.match(/^\/api\/apps(?:\/([^/]+))?(?:\/(\w+))?$/);
    if (appMatch) {
      const [, appId, verb] = appMatch;
      if (cluster.shared() && appId && req.method !== 'GET') {
        const app = (await apps.load(USER_DATA)).find((item) => item.id === appId);
        if (verb && app?.ownerNode && app.ownerNode !== cluster.self.id) return json(res, 409, {
          error: `This app’s processes run on ${cluster.replica.state.history[app.ownerNode]?.name || 'another host'}. Make that machine main to start or stop it.`,
        });
      }

      if (req.method === 'GET' && !appId) {
        // Visibility is not shown in the list (it lives in each app's edit
        // sheet, fetched on demand), so the list does not pay for a gh call
        // per app — that was making the sheet slow to open.
        const list = await apps.listWithStatus(USER_DATA);
        if (cluster.shared()) for (const app of list) if (!app.builtin) app.machines = placement.describe(app);
        return json(res, 200, { apps: list });
      }
      if (req.method === 'POST' && !appId) {
        const body = await readBody(req);
        try {
          const cfg = await loadConfig(USER_DATA);
          if (!cfg.default) return json(res, 400, { error: 'Add an AI source before creating a project.' });
          const placed = cluster.shared() && body.hosts !== undefined ? replicationHosts(body.hosts, cluster.replica.members(), cluster.self.id) : null;
          const app = await apps.create(USER_DATA, { ...body, hosts: placed,
            ownerNode: undefined });
          const session = store.newSession({
            name: 'Tab 1', model: cfg.default, projectDir: app.dir, appId: app.id,
          });
          await store.save(session);
          return json(res, 200, { ...app, sessionId: session.id });
        }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === 'PATCH' && appId) {
        try {
          const patch = await readBody(req);
          delete patch.ownerNode;
          if (patch.hosts !== undefined) {
            if (!cluster.shared()) throw new Error('Join another machine before choosing where this project lives.');
            const app = (await apps.load(USER_DATA)).find((a) => a.id === appId);
            if (!app) throw new Error('no such app');
            patch.hosts = replicationHosts(patch.hosts, cluster.replica.members(), app.ownerNode || app.hosts?.[0] || cluster.self.id);
            if (Object.values(cluster.replica.state.sessions).some(s => s.appId === appId && !patch.hosts.includes(executionOwner(s, app, cluster.self.id))))
              throw new Error('This computer still owns project tabs. Keep it enabled until those tabs are removed.');
          }
          // Every host notices the replicated change and reconciles its copy.
          return json(res, 200, await apps.update(USER_DATA, appId, patch));
        }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === 'DELETE' && appId) {
        if ((await cluster.queue(`turn-queue:${appId}`)).entries.some(unfinished)) return json(res, 409, { error: 'Resolve or skip the project’s pending turns before deleting it.' });
        // Folder, sessions, and GitHub deletion are independent opt-in choices.
        // Validate and complete GitHub deletion before removing local records.
        const wantFiles = url.searchParams.get('files') === '1';
        const wantSessions = url.searchParams.get('sessions') === '1';

        const target = (await apps.load(USER_DATA)).find((a) => a.id === appId);
        if (!target || target.builtin) return json(res, 400, { error: 'This project cannot be deleted.' });
        if (url.searchParams.get('github') === '1' &&
            (await store.list()).some((s) => s.appId === appId && (running.has(s.id) || running.has(s.id + '--monitor')))) {
          return json(res, 409, { error: 'Stop this project’s active sessions before deleting its GitHub repository.' });
        }
        let deletedRepo = null;
        if (url.searchParams.get('github') === '1') {
          try {
            const body = await readBody(req);
            deletedRepo = await git.deleteAppRepo(target, body.confirmRepository);
          } catch (e) { return json(res, 400, { error: e.message }); }
        }
        const attached = (await store.list()).filter((m) => m.appId === appId);
        const removedSessions = [];
        for (const meta of attached) {
          if (wantSessions) {
            running.get(meta.id)?.controller.abort();
            live.delete(meta.id);
            await store.remove(meta.id);
            // A monitor companion is part of its session, not a session of
            // its own, so it goes with it.
            await store.remove(`${meta.id}--monitor`).catch(() => {});
            removedSessions.push(meta.name);
          } else {
            // Sessions outlive the app record; they simply come unattached.
            const sn = await store.load(meta.id, { repair: false }).catch(() => null);
            if (sn) { sn.appId = null; await store.save(sn); }
          }
        }

        try {
          const done = await apps.destroy(USER_DATA, appId, { files: wantFiles });
          return json(res, 200, { ...done, deletedRepo, removedSessions, apps: await apps.load(USER_DATA) });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }
      if (req.method === 'POST' && appId && verb === 'start') {
        try {
          const r = await apps.start(USER_DATA, appId);
          return json(res, 200, { ...r, urls: apps.urlsFor(r.app, await apps.tailnetHost()) });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === 'POST' && appId && verb === 'stop') {
        try { return json(res, 200, await apps.stop(USER_DATA, appId)); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === 'GET' && appId && verb === 'git') {
        const app = (await apps.load(USER_DATA)).find((a) => a.id === appId);
        if (!app) return json(res, 404, { error: 'no such app' });
        return json(res, 200, await git.visibility(app.dir));
      }
      if (req.method === 'POST' && appId && verb === 'visibility') {
        const app = (await apps.load(USER_DATA)).find((a) => a.id === appId);
        if (!app) return json(res, 404, { error: 'no such app' });
        const { visibility } = await readBody(req);
        return json(res, 200, await git.setVisibility(app.dir, visibility));
      }
      if (req.method === 'GET' && appId && verb === 'log') {
        const app = (await apps.load(USER_DATA)).find((a) => a.id === appId);
        if (!app) return json(res, 404, { error: 'no such app' });
        const text = await fs.readFile(apps.logPath(USER_DATA, app), 'utf8').catch(() => '');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(text.slice(-40_000));
      }
    }

    // ---- outbound email, available to every session as a tool
    if (req.method === 'GET' && pathname === '/api/email') {
      const cfg = await loadEmailConfig(USER_DATA);
      // The key itself never leaves the machine; only whether there is one.
      return json(res, 200, { enabled: cfg.enabled, to: cfg.to, from: cfg.from, hasKey: Boolean(cfg.apiKey) });
    }
    if (req.method === 'POST' && pathname === '/api/email') {
      const { enabled, to, from, apiKey, gmailUser, gmailPass, carrier } = await readBody(req);
      if (enabled !== undefined && typeof enabled !== 'boolean') return json(res, 400, { error: 'enabled must be a boolean' });
      const cfg = await saveEmailConfig(USER_DATA, { enabled, to, from, apiKey, gmailUser, gmailPass, carrier });
      return json(res, 200, { enabled: cfg.enabled, to: cfg.to, from: cfg.from, hasKey: Boolean(cfg.apiKey) });
    }
    // ---- restart the harness to apply edits made to its own source
    // A harness-editing session changes files, but the running process keeps
    // the old code until it restarts. Without this, every self-edit looks
    // broken: new endpoints 404, new UI never appears.
    if (req.method === 'GET' && pathname === '/api/harness/status') {
      return json(res, 200, { instanceId, restartId: process.env.ORCHESTRATOR_RESTART_ID || null,
        node: cluster.self.id, pid: process.pid, busy: Boolean(running.size || messageQueue.size), restarting });
    }
    if (req.method === 'POST' && pathname === '/api/harness/restart') {
      if (restarting) return json(res, 409, { error: 'A restart is already in progress.' });
      if (running.size || messageQueue.size) {
        return json(res, 409, { error: 'A turn or queued message is still running — wait for it to finish, then restart.' });
      }
      restarting = true;
      let out, helper;
      try {
        // Cluster-authenticated requests restart only the addressed peer. The
        // browser request rolls through peers first and this host last.
        if (!cluster.trusted(req)) await restartPeers(cluster);
        if (running.size || messageQueue.size) throw new Error('Work started during the restart. Wait for it to finish, then retry.');
        const restartId = crypto.randomUUID();
        out = openSync(path.join(USER_DATA, 'server.log'), 'a');
        helper = spawn(process.execPath, [path.join(__dirname, '../scripts/restart-server.mjs'), String(PORT), path.join(__dirname, 'index.js')], {
          windowsHide: true, detached: true, stdio: ['ignore', out, out, 'ipc'],
          cwd: path.join(__dirname, '..'),
          env: { ...process.env, HARNESS_PORT: String(PORT), HARNESS_DATA_DIR: USER_DATA, ORCHESTRATOR_RESTART_ID: restartId },
        });
        // Do not stop this server until the relauncher has loaded successfully.
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => finish(new Error('Restart helper did not become ready.')), 5000);
          const finish = (error) => {
            clearTimeout(timer);
            helper.removeListener('error', finish);
            helper.removeListener('exit', exited);
            helper.removeListener('message', ready);
            error ? reject(error) : resolve();
          };
          const exited = () => finish(new Error('Restart helper exited before it was ready.'));
          const ready = (message) => { if (message?.ready) finish(); };
          helper.once('error', finish);
          helper.once('exit', exited);
          helper.on('message', ready);
        });
        helper.disconnect();
        helper.unref();
        await json(res, 200, { ok: true, restarting: true, instanceId, restartId, node: cluster.self.id });
        setTimeout(() => shutdown('restart'), 400);
      } catch (error) {
        helper?.kill();
        restarting = false;
        return json(res, 500, { error: `Could not restart: ${error.message}` });
      } finally { if (out !== undefined) closeSync(out); }
      return undefined;
    }

    if (req.method === 'POST' && pathname === '/api/email/test') {
      try {
        const cfg = await loadEmailConfig(USER_DATA);
        const sent = await sendEmail(cfg, {
          subject: 'harness test',
          text: 'This is the harness checking it can reach you. Every session can send mail this way.',
        });
        return json(res, 200, { ok: true, ...sent });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (req.method === 'GET' && pathname === '/api/notify') {
      {
        const n = await loadNotify(USER_DATA);
        const e = await loadEmailConfig(USER_DATA).catch(() => ({}));
        // The password itself never leaves the machine; only whether one exists.
        return json(res, 200, {
          ...n, gmailUser: e.gmailUser ?? null, carrier: e.carrier ?? null, hasGmailPass: Boolean(e.gmailPass),
        });
      }
    }
    if (req.method === 'POST' && pathname === '/api/notify') {
      const body = await readBody(req);
      const problem = notificationSetupError(await notifyConfig(body));
      if (problem) return json(res, 400, { error: problem });
      const cfg = await saveNotify(USER_DATA, { ...(await loadNotify(USER_DATA)), ...body });
      return json(res, 200, cfg);
    }
    if (req.method === 'POST' && pathname === '/api/notify/test') {
      const cfg = await notifyConfig({ ...(await readBody(req)), enabled: true });
      return json(res, 200, await sendNotify(cfg, 'Distributed Orchestrator test — notifications are working.'));
    }

    // GitHub credentials are global; repository visibility remains session-specific.
    if (pathname === '/api/github' && req.method === 'GET') return json(res, 200, await github.status());
    if (pathname === '/api/github/login' && req.method === 'POST') return json(res, 200, await github.start());
    if (pathname === '/api/github/login' && req.method === 'GET') return json(res, 200, github.progress());
    if (pathname === '/api/github/finish' && req.method === 'POST') return json(res, 200, await github.finish());

    // ---- git
    if (req.method === 'GET' && pathname === '/api/git') {
      const id = url.searchParams.get('session');
      const session = id ? (live.get(id) ?? (await store.load(id, { repair: false }).catch(() => null))) : null;
      if (!session) return json(res, 404, { error: 'no such session' });
      return json(res, 200, { ...(await git.status(session.tabWorkspace?.dir ?? session.projectDir)), isolated: Boolean(session.tabWorkspace), enabled: session.gitPush !== false });
    }

    if (req.method === 'POST' && pathname === '/api/git/connect') {
      const { session: id, remote } = await readBody(req);
      const session = live.get(id) ?? (await store.load(id, { repair: false }));
      const res2 = await git.connect(session.projectDir, remote);
      return json(res, res2.ok ? 200 : 400, res2);
    }

    if (req.method === 'POST' && pathname === '/api/git/visibility') {
      const { session: id, visibility } = await readBody(req);
      const session = live.get(id) ?? (await store.load(id, { repair: false }));
      const res2 = visibility
        ? await git.setVisibility(session.projectDir, visibility)
        : await git.visibility(session.projectDir);
      return json(res, 200, res2);
    }

    if (req.method === 'POST' && pathname === '/api/git/push') {
      const { session: id } = await readBody(req);
      const session = live.get(id) ?? (await store.load(id, { repair: false }));
      if (running.has(id)) return json(res, 409, { error: 'Wait for the tab to finish before integrating.' });
      if (!session.tabWorkspace) return json(res, 409, { error: 'Start an isolated coding turn before integrating changes.' });
      const key = queueKey(session);
      let queue = await cluster.queue(key);
      let entry = queue.entries.find(e => e.sessionId === id && e.state === 'blocked');
      if (!entry) {
        if (queue.entries.some(e => e.sessionId === id && unfinished(e))) return json(res, 409, { error: 'This tab already has pending queue work.' });
        queue = await cluster.queue(key, { op: 'enqueue', entry: {
          id: crypto.randomUUID(), key, sessionId: id, name: session.name,
          owner: cluster.self.id, body: {}, createdAt: Date.now(), kind: 'integration',
        } });
        entry = queue.entries.at(-1);
      }
      const last = [...session.events].reverse().find((e) => e.type === 'assistant');
      const startedAt = Date.now();
      running.set(id, { controller: new AbortController(), startedAt, last: 'integration', executionEpoch: session.executionEpoch || 0 });
      live.set(id, session);
      try {
        if (entry.state === 'queued') await updateTurn(entry, 'preparing');
        await awaitPublication(entry, running.get(id).controller.signal);
        if (cluster.shared()) {
          session.turnHost = cluster.self.id;
          session.turnStartedAt = startedAt;
          await store.save(session);
        }
        const result = await integrateTab(session, {
          distributed: (await sessionPlacement(session)).distributed,
          retryPush: true,
          signal: running.get(id).controller.signal,
          onCheck: (log) => upsertMonitor(USER_DATA, { id: `integration-${id}`, label: 'Integration checks', kind: 'file', path: log, session: id }),
          push: (await github.status()).authenticated,
          model: session.model, servedModel: last?.servedModel,
        });
        if (!result.ok || ((await sessionPlacement(session)).distributed && !result.pushed && result.skipped !== 'no changes'))
          throw new Error(result.error || result.reason || 'Publication did not finish.');
        await updateTurn(entry, 'done', result.sha || result.skipped || 'integrated');
        if (result.commitUrl) {
          const note = noteEvent(`git: integrated and pushed · ${result.sha}`, { sha: result.sha, commitUrl: result.commitUrl });
          session.events.push(note);
          broadcast(id, { kind: 'event', event: note });
        }
        await store.save(session);
        return json(res, 200, result);
      } catch (e) {
        await updateTurn(entry, 'blocked', e.message).catch(() => {});
        return json(res, 409, { error: e.message });
      } finally {
        if (session.turnHost) {
          delete session.turnHost;
          delete session.turnStartedAt;
          await store.save(session).catch(() => {});
        }
        live.delete(id);
        running.delete(id);
      }
    }

    // ---- monitors: whatever the user or the agent asked to watch
    if (req.method === 'GET' && pathname === '/api/monitors') {
      const scope = url.searchParams.get('session') ?? undefined;
      const monitors = await loadMonitors(USER_DATA, { session: scope });
      return json(res, 200, {
        monitors,
        samples: await sampleAll(monitors),
        file: monitorsPath(USER_DATA),
        kinds: KINDS,
      });
    }
    if (req.method === 'POST' && pathname === '/api/monitors') {
      const monitors = await upsertMonitor(USER_DATA, await readBody(req));
      return json(res, 200, { ok: true, monitors });
    }
    if (req.method === 'DELETE' && pathname === '/api/monitors') {
      const { id } = await readBody(req);
      return json(res, 200, { ok: true, monitors: await removeMonitor(USER_DATA, id) });
    }

    // ---- background jobs the agent detached with nohup/&
    if (req.method === 'GET' && pathname === '/api/procs') {
      const ps = await new Promise((resolve) => {
        execFile('ps', ['-eo', 'pid=,ppid=,etime=,pcpu=,rss=,command='], { maxBuffer: 8e6 },
          (err, out) => resolve(err ? '' : out));
      });

      const mine = [];
      for (const line of ps.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        const [, pid, ppid, etime, pcpu, rss, command] = m;

        // Long-running work the agent started, not the whole machine: node,
        // python, playwright/chrome and the like. The harness's own server and
        // the ps call itself are noise.
        if (!/\b(node|python3?|deno|bun|ruby|playwright|chromium|Google Chrome Helper|curl|wget|ffmpeg)\b/i.test(command)) continue;
        if (command.includes('server/index.js') || command.startsWith('ps ')) continue;

        mine.push({
          pid: Number(pid),
          ppid: Number(ppid),
          detached: Number(ppid) === 1, // nohup'd: survives the turn that spawned it
          etime,
          cpu: Number(pcpu),
          rssMb: Math.round(Number(rss) / 1024),
          command: command.slice(0, 400),
        });
      }

      // A detached job's stdout is usually redirected to a log file; lsof can
      // name it, which is the difference between "something is running" and
      // being able to watch it.
      await Promise.all(mine.map((proc) => new Promise((resolve) => {
        execFile('lsof', ['-p', String(proc.pid), '-a', '-d', '1', '-Fn'], { timeout: 4000 },
          (err, out) => {
            if (!err) {
              const found = (out ?? '').split('\n').find((l) => l.startsWith('n/') && !l.includes('/dev/'));
              if (found) proc.log = found.slice(1);
            }
            resolve();
          });
      })));

      mine.sort((a, b) => b.cpu - a.cpu);
      return json(res, 200, { procs: mine, at: Date.now() });
    }

    if (req.method === 'POST' && pathname === '/api/procs/stop') {
      const { pid, force } = await readBody(req);
      if (!Number.isInteger(pid) || pid <= 1) return json(res, 400, { error: 'bad pid' });
      try {
        process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // ---- usage: a lookup against the ledger, not a scan of transcripts
    if (req.method === 'GET' && pathname === '/api/usage') {
      const window = url.searchParams.get('window') || 'seven_day';
      const cfg = await loadConfig(USER_DATA);

      // A read is a sum over buckets; no transcript is opened here. `refresh=1`
      // forces a collection first, for when a caller wants it up to the second.
      if (url.searchParams.get('refresh') === '1') await collectUsage();

      const span = usageStore.resolvePeriod(usage, window)
        ?? usageStore.resolvePeriod(usage, 'seven_day');
      const models = usageStore.query(usage, { from: span.from, to: span.to, models: cfg.models });

      for (const [alias, spec] of Object.entries(cfg.models)) {
        if (models.some((m) => m.alias === alias)) continue;
        models.push({
          alias, label: spec.label ?? alias, provider: spec.provider,
          turns: 0, input: 0, output: 0, cached: 0, ms: 0, tools: 0, cost: 0,
        });
      }

      const provider = {};
      for (const [alias, saved] of Object.entries(usage.limits ?? {})) {
        provider[alias] = { ...normalizeProviderLimits(saved.info), reportedAt: saved.at };
      }

      // Codex reports plan usage to its rollout files rather than down its
      // stream, and that figure covers the whole account. So a Codex model
      // that has not run a turn here yet can still show a true percentage,
      // rather than an empty card promising one after the next turn.
      const needsCodex = Object.entries(cfg.models)
        .filter(([alias, spec]) => spec.provider === 'codex-cli' && !provider[alias]);
      if (needsCodex.length) {
        const info = await codexCli.latestRateLimits().catch(() => null);
        if (info) {
          for (const [alias] of needsCodex) {
            provider[alias] = { ...normalizeProviderLimits(info), reportedAt: null };
          }
        }
      }

      return json(res, 200, {
        window,
        windows: Object.keys(WINDOWS),
        models,
        provider,
        sessionCount: Object.keys(usage.cursors).length,
        collectedAt: usage.updatedAt,
      });
    }

    // ---- file browsing: folders AND files, with previews
    if (req.method === 'GET' && pathname === '/api/files') {
      const asked = url.searchParams.get('path') || state0Dir();
      let dir = path.resolve(asked);
      let note = null;
      while (dir !== path.dirname(dir)) {
        try {
          if ((await fs.stat(dir)).isDirectory()) break;
        } catch { /* keep walking up */ }
        dir = path.dirname(dir);
      }
      if (dir !== path.resolve(asked)) note = `${asked} no longer exists — showing ${dir}`;

      const entries = await fs.readdir(dir, { withFileTypes: true });
      const dirs = [];
      const files = [];
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          dirs.push({ name: e.name, path: full });
        } else if (e.isFile()) {
          const size = await fs.stat(full).then((st) => st.size).catch(() => 0);
          files.push({ name: e.name, path: full, size, kind: kindOf(e.name) });
        }
      }
      return json(res, 200, {
        path: dir,
        note,
        parent: path.dirname(dir) === dir ? null : path.dirname(dir),
        dirs: dirs.sort((a, b) => a.name.localeCompare(b.name)),
        files: files.sort((a, b) => a.name.localeCompare(b.name)),
      });
    }

    // ---- one file's contents, for the phone to render
    if (req.method === 'GET' && pathname === '/api/file') {
      let file = path.resolve(url.searchParams.get('path') ?? '');
      if (cluster.shared()) file = await clusterAssets.resolve(file);
      const st = await fs.stat(file).catch(() => null);
      if (!st?.isFile()) return json(res, 404, { error: 'not a file' });

      const kind = kindOf(file);
      // A phone should not be asked to swallow a 20 MB page of HTML; text is
      // truncated with a note, images are sent whole.
      const TEXT_CAP = 400_000;
      // For a growing log the interesting end is the last one, so ?tail=1
      // reads from the back instead of the front.
      const wantTail = url.searchParams.get('tail') === '1';
      if (kind === 'text' && (st.size > TEXT_CAP || wantTail)) {
        const span = Math.min(TEXT_CAP, st.size);
        const from = wantTail ? Math.max(0, st.size - span) : 0;
        const fh = await fs.open(file, 'r');
        const buf = Buffer.alloc(span);
        await fh.read(buf, 0, span, from);
        await fh.close();
        const note = st.size > span
          ? (wantTail
            ? `--- showing the last ${span} of ${st.size} bytes ---\n\n`
            : `\n\n--- truncated: showing the first ${span} of ${st.size} bytes ---`)
          : '';
        const body = wantTail ? note + buf.toString('utf8') : buf.toString('utf8') + note;
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(body);
      }

      const body = await fs.readFile(file);
      const download = url.searchParams.get('download') === '1';
      res.writeHead(200, {
        'Content-Type': download
          ? 'application/octet-stream'
          : MIME_FILE[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        ...(download
          ? { 'Content-Disposition': `attachment; filename="${path.basename(file).replace(/"/g, '')}"` }
          : {}),
      });
      return res.end(body);
    }

    // ---- a look at the laptop's screen, for when a tool opens a window
    if (req.method === 'POST' && pathname === '/api/dirs') {
      const { parent, name } = await readBody(req);
      if (!name || /[/\\]/.test(name)) return json(res, 400, { error: 'invalid folder name' });
      const made = path.join(parent, name);
      await fs.mkdir(made, { recursive: true });
      return json(res, 200, { path: made });
    }

    // ---- sessions
    const m = pathname.match(/^\/api\/sessions(?:\/([^/]+))?(?:\/(\w+))?$/);
    if (m) {
      const [, id, verb] = m;

      if (req.method === 'GET' && id && verb === 'projectqueue') {
        const session = await store.load(id, { repair: false });
        const queue = await cluster.queue(queueKey(session));
        return json(res, 200, { entries: queue.entries.map(({ body, ...entry }) => entry) });
      }
      if (req.method === 'POST' && id && verb === 'skipturn') {
        if (running.has(id) || messageQueue.busy(id)) return json(res, 409, { error: 'Stop this tab and wait for it to finish first.' });
        const session = await store.load(id, { repair: false });
        const { entryId } = await readBody(req);
        const queue = await cluster.queue(queueKey(session));
        const entry = queue.entries.find(e => e.id === entryId && e.sessionId === id);
        if (!entry || !['queued', 'blocked'].includes(entry.state)) return json(res, 409, { error: 'Only a queued or blocked turn can be skipped.' });
        await updateTurn(entry, 'cancelled', 'Explicitly skipped; unpublished work remains in the owner’s tab.');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && id && verb === 'machine') {
        const session = await store.load(id, { repair: false });
        const { ownerNode } = await readBody(req);
        if ((await cluster.queue(queueKey(session))).entries.some(e => e.sessionId === id && unfinished(e))) return json(res, 409, { error: 'Resolve this tab’s queue entries before changing computers.' });
        const { hosts } = await sessionPlacement(session);
        const error = assignmentError(session, ownerNode, hosts);
        if (error) return json(res, 409, { error });
        const inventory = ownerNode === cluster.self.id ? await loadConfig(USER_DATA) : await cluster.hostModels(ownerNode);
        if (!inventory.models[session.model]) session.model = inventory.default;
        // Assignment shares the same serialized commit path as worker writes.
        const assign = latest => {
          const changed = assignmentError(latest, ownerNode, hosts);
          if (changed) throw new Error(changed);
          latest.model = session.model;
          latest.ownerNode = ownerNode;
          latest.executionEpoch = (latest.executionEpoch || 0) + 1;
          return latest;
        };
        try {
          const updated = cluster.shared() ? await cluster.changeSession(id, assign) : await store.save(assign(session));
          return json(res, 200, updated);
        } catch (e) { return json(res, 409, { error: e.message }); }
      }
      if (req.method === 'GET' && id && verb === 'models') {
        const cfg = await loadConfig(USER_DATA);
        return json(res, 200, { models: Object.fromEntries(Object.entries(cfg.models).map(([key, m]) => [key, { ...m, apiKey: undefined }])), default: cfg.default });
      }
      if (req.method === 'POST' && !id) {
        const { name, model, projectDir: askedDir, system, mode, appId, ownerNode: requestedOwner } = await readBody(req);
        let ownerNode = cluster.self.id;
        // An app owns its directory; a session attached to one works there
        // rather than carrying a directory of its own.
        let projectDir = askedDir;
        let editsHarness = false;
        if (appId) {
          const app = (await apps.load(USER_DATA)).find((a) => a.id === appId);
          if (!app) return json(res, 400, { error: 'no such app' });
          projectDir = app.dir;
          editsHarness = Boolean(app.editsHarness);
          const eligible = executionHosts(app, cluster.replica.members(), cluster.self.id);
          ownerNode = requestedOwner || (eligible.includes(cluster.self.id) ? cluster.self.id : eligible[0]);
          if (!eligible.includes(ownerNode)) return json(res, 400, { error: 'This computer is not enabled for the project.' });
        }
        // A session may not be rooted where it could modify the harness — unless
        // it is a session of the built-in Harness app, which is allowed the
        // harness source (never its data directory).
        const refusal = refuseAsProjectDir(projectDir, { allowHarnessSource: editsHarness });
        if (refusal) return json(res, 400, { error: refusal });
        // Typing a path that does not exist yet is a normal thing to do on a
        // phone; create it now rather than failing on the first tool call.
        if (projectDir && ownerNode === cluster.self.id) await fs.mkdir(projectDir, { recursive: true });
        const inventory = ownerNode === cluster.self.id ? await loadConfig(USER_DATA) : await cluster.hostModels(ownerNode);
        const selectedModel = inventory.models[model] ? model : inventory.default;
        const session = store.newSession({ name, model: selectedModel, projectDir, system, mode, appId: appId ?? null });
        session.ownerNode = ownerNode;
        if (editsHarness) session.editsHarness = true;
        await store.save(session);
        return json(res, 200, session);
      }
      if (req.method === 'GET' && id && !verb) {
        // While a turn runs, the in-memory copy is the truth; reading the file
        // would race the writer and trip the crash-repair path.
        const session = live.get(id) ?? (await store.load(id, { repair: !running.has(id) }));
        session.projectDirMissing = !(await fs
          .stat(session.projectDir)
          .then((st) => st.isDirectory())
          .catch(() => false));
        // Rooted at home means every project on the machine is in scope, which
        // is never what was wanted and is worth surfacing rather than inferring.
        session.projectDirIsHome = path.resolve(session.projectDir) === path.resolve(os.homedir());
        return json(res, 200, session);
      }
      if (req.method === 'DELETE' && id) {
        const deleting = await store.load(id, { repair: false });
        if ((await cluster.queue(queueKey(deleting))).entries.some(e => e.sessionId === id && unfinished(e))) return json(res, 409, { error: 'Resolve or skip this tab’s queue entries before deleting it.' });
        if (running.has(id)) return json(res, 409, { error: 'Stop the turn and wait for it to finish before deleting this session.' });
        live.delete(id);
        await store.remove(id);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'PATCH' && id) {
        const session = live.get(id) ?? (await store.load(id, { repair: !running.has(id) }));
        const patch = await readBody(req);
        if (running.has(id)) return json(res, 409, { error: 'Wait for the current turn and integration to finish before editing this session.' });
        if ((patch.projectDir !== undefined || patch.appId !== undefined) && (await cluster.queue(queueKey(session))).entries.some(e => e.sessionId === id && unfinished(e)))
          return json(res, 409, { error: 'Resolve or skip this tab’s pending turns before moving its project.' });
        delete patch.queueTurn;
        delete patch.ownerNode;
        delete patch.executionEpoch;
        delete patch.turnHost;
        delete patch.turnStartedAt;
        delete patch.tabWorkspace;
        delete patch.integrationLog;
        if (patch.projectDir && patch.projectDir !== session.projectDir) delete session.tabWorkspace;
        const badDir = refuseAsProjectDir(patch.projectDir);
        if (badDir) return json(res, 400, { error: badDir });
        if (patch.projectDir) await fs.mkdir(patch.projectDir, { recursive: true });

        // Record a switch in the transcript. Without this there is no evidence
        // it happened, which is exactly how a silently-failed switch goes
        // unnoticed until the answers look wrong.
        const from = session.model;
        Object.assign(session, patch);
        if (patch.model && patch.model !== from) {
          session.events.push(noteEvent(`model switched from ${from} to ${patch.model} — history carries over`));
        }

        await store.save(session);
        return json(res, 200, session);
      }
      // Editing the past. Both refuse while a turn is running: the transcript
      // in memory is the one the model is mid-way through sending.
      if (req.method === 'POST' && id && ['erase', 'rewind'].includes(verb)) {
        if (running.has(id)) return json(res, 409, { error: 'Stop the turn and wait for it to finish before editing this conversation.' });
        const { eventId, revertFiles = false } = await readBody(req);
        const session = await store.load(id, { repair: false });
        if ((await cluster.queue(queueKey(session))).entries.some(e => e.sessionId === id && unfinished(e))) return json(res, 409, { error: 'Resolve or skip this tab’s queue entries before rewriting its conversation.' });
        if (revertFiles) return json(res, 409, { error: 'File rewind is disabled with ordered integration. Ask a new turn to undo the change so it is merged and checked in queue order.' });
        try {
          if (verb === 'erase') {
            const { events, removed, describe } = eraseEvent(session.events, eventId);
            session.events = events;
            session.events.push(noteEvent(`removed ${describe} from the conversation — it is no longer sent to the model`));
            await store.save(session);
            return json(res, 200, { ok: true, removed, session });
          }

          // Rewind conversation only; code reversals are new queued turns.
          const { events, removed, draft, attachments: atts } = rewindTo(session.events, eventId);
          session.events = events;
          session.events.push(noteEvent(`rewound the conversation here — ${removed} later event(s) removed`));
          await store.save(session);
          return json(res, 200, { ok: true, removed, draft, attachments: atts, git: null, session });
        } catch (e) {
          return json(res, 400, { error: e?.message ?? String(e) });
        }
      }

      if (req.method === 'POST' && id && verb === 'fork') {
        const { model, name } = await readBody(req);
        return json(res, 200, await store.fork(id, { model, name }));
      }
      // The monitoring tab's chat: a companion session that edits the panel
      // instead of the project. Created on first open, not before.
      if (req.method === 'GET' && id && verb === 'monitor') {
        const monitorId = `${id}--monitor`;
        let companion = live.get(monitorId)
          ?? (await store.load(monitorId, { repair: !running.has(monitorId) }).catch(() => null));

        if (!companion) {
          const parent = live.get(id) ?? (await store.load(id, { repair: false }));
          companion = store.newSession({
            name: `monitor: ${parent.name}`,
            model: parent.model,
            projectDir: parent.projectDir,
            system: '',
          });
          companion.id = monitorId;          // deterministic, so it is found again
          companion.monitorFor = id;
          companion.ownerNode = parent.ownerNode;
          companion.confineToProjectDir = false; // monitors often watch /tmp logs
          await store.save(companion);
        }
        companion.projectDirMissing = !(await fs.stat(companion.projectDir)
          .then((st) => st.isDirectory()).catch(() => false));
        return json(res, 200, companion);
      }

      if (req.method === 'GET' && id && verb === 'stats') {
        const session = live.get(id) ?? (await store.load(id, { repair: !running.has(id) }));
        const { models } = await loadConfig(USER_DATA);
        return json(res, 200, tally(session.events, models));
      }
      if (req.method === 'POST' && id && verb === 'stop') {
        messageQueue.cancel(id);
        const stopping = await store.load(id, { repair: false });
        const queue = await cluster.queue(queueKey(stopping));
        for (const entry of queue.entries.filter(e => e.sessionId === id && e.state === 'queued')) await updateTurn(entry, 'cancelled', 'Cancelled by Stop.');
        running.get(id)?.controller.abort();
        return json(res, 200, { ok: true });
      }

      // Live transcript. One stream per open phone; several may watch at once.
      if (req.method === 'GET' && id && verb === 'events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const live = running.get(id);
        res.write(`retry: 2000\n\ndata: ${JSON.stringify({
          kind: 'hello',
          running: Boolean(live),
          startedAt: live?.startedAt ?? null,
          last: live?.last ?? null,
        })}\n\n`);

        if (!listeners.has(id)) listeners.set(id, new Set());
        listeners.get(id).add(res);

        // Phones suspend radios aggressively; a heartbeat keeps NAT and the
        // browser from quietly dropping the connection.
        const beat = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(beat);
          listeners.get(id)?.delete(res);
        });
        return undefined;
      }

      // Raw-bytes upload. Multipart would mean a parser and an extra
      // dependency for no benefit; the filename rides in a header.
      if (req.method === 'POST' && id && verb === 'upload') {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > attachments.MAX_BYTES) return json(res, 413, { error: 'image too large (25 MB limit)' });
          chunks.push(c);
        }
        if (!size) return json(res, 400, { error: 'empty upload' });

        const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'image.jpg'));
        try {
          const att = await attachments.store(USER_DATA, id, { name, buffer: Buffer.concat(chunks) });
          if (cluster.shared()) await clusterAssets.capture(att);
          return json(res, 200, att);
        } catch (e) {
          return json(res, 400, { error: e?.message ?? String(e) });
        }
      }

      if (req.method === 'POST' && id && ['send', 'queue'].includes(verb)) {
        if (restarting) return json(res, 409, { error: 'The server is restarting. Try again when it reconnects.' });
        const body = await readBody(req);
        if ((!body.text || !String(body.text).trim()) && !body.attachments?.length) return json(res, 400, { error: 'Enter a message or attach a file.' });
        try {
          const session = await store.load(id, { repair: false });
          const key = queueKey(session);
          const entryId = crypto.randomUUID();
          const queue = await cluster.queue(key, { op: 'enqueue', allowQueue: verb === 'queue', entry: {
            id: entryId, key, sessionId: id, name: session.name,
            owner: cluster.self.id, body, createdAt: Date.now(),
          } });
          const entry = queue.entries.find(e => e.id === entryId);
          const queued = messageQueue.busy(id) || running.has(id);
          await scheduleTurn(entry);
          return json(res, queued ? 202 : 200, { ok: true, queued, number: entry.number });
        } catch (e) { return json(res, 409, { error: e.message }); }
      }
    }

    return json(res, 404, { error: `no route for ${req.method} ${pathname}` });
  } catch (e) {
    return json(res, 500, { error: e?.message ?? String(e) });
  }
});

// -------------------------------------------------------------------- start

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return '127.0.0.1';
}

await store.init(USER_DATA);
TOKEN = await resolveToken(USER_DATA);
cluster = await createCluster(USER_DATA, { port: PORT });
pairing = hostPairing({ cluster, inventory, join: joinHost, publish: async () => {
  // Reuses the Phone access routine: it never replaces an existing Serve route.
  const n = await setupPhoneAccess(PORT);
  if (n.phoneUrl) return cluster.setUrl(n.phoneUrl);
  if (n.approvalUrl) throw new Error(`Tailscale must allow HTTPS for this computer first. Approve it at ${n.approvalUrl} and tap request to join again.`);
  throw new Error(n.connected ? n.message : 'Tailscale is not connected on this computer. Sign in to Tailscale, then tap request to join again.');
} });
store.useCluster(cluster);
workspaces = portableWorkspaces(cluster);
placement = appPlacement(cluster, USER_DATA, {
  // A replica's apps.json is only rewritten while it is main, so read the
  // replicated record directly.
  loadApps: async () => {
    const shared = cluster.replica.state.values['settings:apps.json'];
    return shared ? JSON.parse(shared).apps || [] : apps.load(USER_DATA);
  },
  running: (appId) => [...running.keys()].some((id) => live.get(id)?.appId === appId),
});
clusterAssets = replicatedAssets(cluster, USER_DATA);
cluster.replica.start();
// Each computer updates its own installed checkout; restart stays explicit.
setInterval(async () => {
  if (checkingHarnessUpdate || restarting || running.size || messageQueue.size) return;
  checkingHarnessUpdate = true;
  try {
    const result = await syncHarnessCheckout(harnessDir, { busy: () => Boolean(restarting || running.size || messageQueue.size) });
    harnessUpdate = { ...result, restartRequired: Boolean(loadedRevision && result.head !== loadedRevision) };
  } catch (e) { harnessUpdate = { ...harnessUpdate, error: e.message }; }
  finally { checkingHarnessUpdate = false; }
}, 30_000).unref();
let pumpingQueue = false;
setInterval(async () => {
  if (pumpingQueue) return;
  pumpingQueue = true;
  try {
    for (const [key, value] of Object.entries(cluster.replica.state.values)) {
      if (!key.startsWith('turn-queue:')) continue;
      for (const entry of value.entries) {
        if (entry.owner !== cluster.self.id || !unfinished(entry) || messageQueue.busy(entry.sessionId) || running.has(entry.sessionId)) continue;
        if (entry.state === 'queued' && value.entries.some(e => e.sessionId === entry.sessionId && e.number < entry.number && unfinished(e))) continue;
        if (entry.state === 'queued' && entry.kind !== 'integration') await scheduleTurn(entry);
        else if (entry.state !== 'blocked') await updateTurn(entry, 'blocked', 'Owner restarted or turn stopped; work is preserved. Retry integration or skip explicitly.');
      }
    }
  } catch { /* coordinator unavailable; retain all entries for the next pass */ }
  finally { pumpingQueue = false; }
}, 1000).unref();

// Discover our published address without changing the user's Serve routes.
networkStatus(PORT).then((n) => cluster.setUrl(n.phoneUrl)).catch(() => {});
/**
 * The coordinator marks turns interrupted when their execution host disappears.
 * Healthy replicas may keep executing; becoming a follower is not a failure.
 * Nothing is replayed, and an interrupted writer is fenced by its epoch.
 */
let reconciling = false;
async function failOrphanedTurns() {
  if (reconciling || !cluster.shared()) return;
  reconciling = true;
  try {
    for (const [id, value] of Object.entries(cluster.replica.state.sessions)) {
      if (!value?.turnHost || running.has(id)) continue;
      if (value.turnHost === cluster.self.id && cluster.replica.role !== 'leader') {
        await cluster.reportStoppedTurn(value);
        continue;
      }
      if (!cluster.replica.writable()) continue;
      if (value.turnHost !== cluster.self.id && cluster.status().hosts.some(n => n.id === value.turnHost && n.active)) continue;
      const host = value.turnHost === cluster.self.id ? 'this host'
        : cluster.replica.state.history[value.turnHost]?.name || 'another host';
      const note = noteEvent(
        `turn interrupted — it was running on ${host}, which stopped or disconnected before it finished. `
        + 'Nothing was replayed. Work it had started may have partly happened, so check the project '
        + 'before assuming nothing did. Reconnect its computer before sending another message.',
      );
      const changed = await cluster.changeSession(id, current => recoverStoppedTurn(current, value, note));
      if (!changed) continue;
      broadcast(id, { kind: 'event', event: note });
      broadcast(id, { kind: 'done' });
    }
  } catch { /* retried on the next pass */ } finally { reconciling = false; }
}
setInterval(() => {
  if (cluster.shared()) for (const [id, turn] of running) {
    if (turn.checkingOwner) continue;
    turn.checkingOwner = true;
    cluster.readSession(id, true).then(s => {
      if (s?.ownerNode !== cluster.self.id || (s.executionEpoch || 0) !== (turn.executionEpoch || 0)) turn.controller.abort();
    }).catch(() => turn.controller.abort()).finally(() => { turn.checkingOwner = false; });
  }
  failOrphanedTurns();
}, 500).unref();
setInterval(async () => {
  if (!cluster.replica.writable()) return;
  try {
    for (const [id, at] of cluster.replica.lastContact) {
      if ((cluster.replica.state.values['host-seen:' + id] || 0) < at) await cluster.command({ type: 'value', id: 'host-seen:' + id, value: at });
    }
  } catch { /* A new main will continue collecting sightings. */ }
}, 30000).unref();

// Each host keeps its own copies of the projects placed on it (see placement.js).
let placementFingerprint = '';
let placementAt = 0;
setInterval(() => {
  if (!cluster.shared()) return;
  const fingerprint = String(cluster.replica.state.values['settings:apps.json']);
  if (fingerprint === placementFingerprint && Date.now() - placementAt < 120_000) return;
  placementFingerprint = fingerprint; placementAt = Date.now();
  placement.reconcile().catch(() => { placementAt = 0; });
}, 10_000).unref();
// Project files used to be copied into the cluster log as checkpoints. Git
// placement replaced them; drop the old copies so the log stays small.
setInterval(async () => {
  if (!cluster.replica.writable()) return;
  try {
    for (const id of Object.keys(cluster.replica.state.values)) {
      if (id.startsWith('workspace:')) await cluster.replica.propose({ type: 'value', id, value: null });
    }
  } catch { /* the next main finishes the cleanup */ }
}, 60_000).unref();

usage = await usageStore.load(USER_DATA);
await collectUsage({ force: true });      // catch up on anything missed while down
setInterval(() => collectUsage().catch(() => {}), 60_000).unref();

/**
 * The wedge watcher.
 *
 * Runs on a plain timer in the server, deliberately outside any model: a turn
 * that has stopped progressing is exactly the thing that cannot report itself.
 * When a beacon goes stale the user is told through whatever channel they have
 * configured, and by email if that is set up, because the whole point is that
 * they are not at the laptop watching.
 */
async function checkForStalls() {
  // Each beacon carries its own threshold; an override applies to all of them.
  const override = process.env.HARNESS_STALL_MS ? Number(process.env.HARNESS_STALL_MS) : undefined;
  const due = beacons.due(override ? { stallMs: override } : {});
  for (const stall of due) {
    const session = live.get(stall.sessionId);
    const text = wedgeMessage({
      sessionName: session?.name ?? stall.sessionId,
      model: stall.model,
      silentMs: stall.silentMs,
      runningMs: stall.runningMs,
      lastActivity: stall.lastActivity,
    });

    // Into the transcript first: the evidence must survive even if every
    // outbound channel fails.
    if (session) {
      const note = noteEvent(`stalled — ${text}`);
      session.events.push(note);
      broadcast(stall.sessionId, { kind: 'event', event: note });
      await store.save(session).catch(() => {});
    }

    const cfg = await notifyConfig().catch(() => null);
    if (cfg?.enabled) await sendNotify(cfg, text).catch(() => {});
    const email = await loadEmailConfig(USER_DATA).catch(() => null);
    if (email?.enabled && email?.apiKey && email?.to) {
      await sendEmail(email, { subject: 'A harness turn has stalled', text, session: stall.sessionId }).catch(() => {});
    }
  }
}
setInterval(() => { checkForStalls().catch(() => {}); }, 30_000).unref();

/**
 * A turn that was running when the harness stopped used to vanish without a
 * trace: the transcript simply ended on a tool result, which reads as "it
 * finished and said nothing" rather than "this was cut off". That is the worst
 * kind of failure — one with nowhere to look. A shutdown now aborts the turns
 * it is interrupting and writes the interruption into each transcript before
 * the process goes away, so the evidence outlives the server.
 */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  cluster?.replica.stop();

  const interrupted = [...running.entries()];
  for (const [id, turn] of interrupted) {
    turn.controller?.abort();
    const session = live.get(id);
    if (!session) continue;
    const note = noteEvent(
      `turn interrupted — the harness stopped (${signal}) while this was running. `
      + 'Work it had started in the background may have carried on regardless, so check the '
      + 'project directory before assuming nothing happened. Send another message to continue.',
    );
    session.events.push(note);
    delete session.turnHost;
    broadcast(id, { kind: 'event', event: note });
    // Best effort: the process is going away either way, and a failed save
    // must not stop the other sessions from getting their note.
    try { await store.save(session); } catch { /* nothing better to do here */ }
  }

  if (usage) await usageStore.save(USER_DATA, usage).catch(() => {});
  server.close();
  // Long enough for those notes to reach a phone that is still listening.
  if (interrupted.length) await new Promise((r) => { setTimeout(r, 250); });
  process.exit(0);
}
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { shutdown(sig).catch(() => process.exit(1)); });
}

server.listen(PORT, '0.0.0.0', () => {
  const t = TOKEN ? `?t=${TOKEN}` : '';
  console.log(`\n  harness is up\n`);
  console.log(`  local:    http://localhost:${PORT}/${t}`);
  console.log(`  network:  http://${lanAddress()}:${PORT}/${t}\n`);
  console.log(`  data: ${USER_DATA}`);
  console.log(TOKEN
    ? '  a token is required. bookmark the bare address; the cookie carries it.\n'
    : '  open to anyone on this network. HARNESS_TOKEN=auto requires a token.\n');
});
