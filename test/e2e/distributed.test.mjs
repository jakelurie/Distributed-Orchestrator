import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { prepareTab } from '../../src/core/tab-workspaces.js';
import { once } from 'node:events';
import { listeningProcesses, runningInfo, stop as stopApp } from '../../src/core/apps.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-hosts-'));
const hosts = [];
const pause = () => new Promise(r => setTimeout(r, 150));
let release;
const modelRequests = [];
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks));
  modelRequests.push(body);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: body.model }, finish_reason: null }] })}\n\n`);
  if (body.messages.at(-1)?.content === 'wait') await new Promise(r => { release = r; });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
async function start(name) {
  const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const dir = path.join(root, name); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify({ default: name, models: { [name]: {
    provider: 'openai', model: name, label: name, baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
  } } }));
  const origin = `http://127.0.0.1:${port}`;
  const fixture = path.join(dir, 'jev-fetch.mjs');
  await fs.writeFile(fixture, `
    const original = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (String(url) !== 'https://api.typesafe.ai/v1/systemone') return original(url, options);
      const body = JSON.parse(options.body);
      if (options.headers.Authorization !== 'Bearer synthetic-jev-key' || body.model !== 'jev-latest')
        return Promise.resolve(new Response('{}', {status: 401}));
      return Promise.resolve(Response.json({ model: 'jev-test', answers: { urgent: {type: 'noul', noul: 0.9} }, usage: {input_tokens: 10} }));
    };
  `);
  const launch = () => spawn(process.execPath, ['--import', fixture, 'server/index.js'], { env: { ...process.env,
    HARNESS_PORT: String(port), HARNESS_TOKEN: 'execution-test', HARNESS_DATA_DIR: dir,
    ORCHESTRATOR_PUBLIC_URL: origin, ORCHESTRATOR_NODE_NAME: name,
  }, stdio: 'ignore' });
  const child = launch();
  const closed = once(child, 'exit');
  const request = (route, method = 'GET', body) => fetch(origin + route, { method,
    headers: { 'Content-Type': 'application/json', 'x-harness-token': 'execution-test' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const call = async (...args) => { const r = await request(...args); const v = await r.json(); assert.ok(r.ok, JSON.stringify(v)); return v; };
  const host = { child, closed, call, request, dir, restart: async () => {
    host.child = launch(); host.closed = once(host.child, 'exit');
    for (let i = 0; i < 60; i++) { try { await call('/api/cluster/status'); return; } catch { await pause(); } }
    throw Error('server did not restart');
  } }; hosts.push(host);
  for (let i = 0; i < 60; i++) { try { host.status = await call('/api/cluster/status'); return host; } catch { await pause(); } }
  throw Error('server did not start');
}
try {
  // A real listener on a reused port belongs to its directory, not the old app.
  const groceryDir = path.join(root, 'grocery');
  await fs.mkdir(groceryDir);
  const listener = spawn(process.execPath, ['-e', "require('http').createServer((q,r)=>r.end('grocery')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { cwd: groceryDir });
  const listenerExit = once(listener, 'exit');
  try {
    const [data] = await once(listener.stdout, 'data');
    const port = Number(String(data).trim());
    const processes = await listeningProcesses();
    const actual = processes.find(p => p.pid === listener.pid && p.port === port);
    assert.ok(actual, 'running listener discovered');
    assert.equal(runningInfo({ dir: path.join(root, 'parallel'), port }, processes).running, false);
    if (actual.cwd) assert.equal(runningInfo({ dir: groceryDir, port }, processes).running, true);
    const parent = { id: 'parent', dir: root, port };
    const grocery = { id: 'grocery', dir: groceryDir, port };
    assert.equal(runningInfo(parent, processes, [parent, grocery]).running, false);
    const registry = path.join(root, 'app-registry');
    await fs.mkdir(registry);
    await fs.writeFile(path.join(registry, 'apps.json'), JSON.stringify({ apps: [
      { id: 'parallel', name: 'Parallel', dir: path.join(root, 'parallel'), port },
    ] }));
    await stopApp(registry, 'parallel');
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'grocery');
  } finally { listener.kill(); await listenerExit; }
  const a = await start('model-a'), b = await start('model-b');
  await b.call('/api/cluster/join', 'POST', { url: a.status.hosts[0].url, ownUrl: b.status.hosts[0].url, token: 'execution-test' });
  assert.deepEqual(await a.call('/api/jev'), { configured: false });
  assert.equal((await a.request('/api/jev/evaluate', 'POST', {})).status, 400);
  assert.equal((await b.request('/api/jev', 'PUT', {apiKey: ''})).status, 400);
  const savedJev = await b.call('/api/jev', 'PUT', { apiKey: 'synthetic-jev-key' });
  assert.deepEqual(savedJev, { configured: true });
  assert.deepEqual(await a.call('/api/jev'), { configured: true });
  assert.equal((await a.request('/api/jev/evaluate', 'POST', {})).status, 400);
  const evaluated = await b.call('/api/jev/evaluate', 'POST', {state: 'urgent', questions: {urgent: {type: 'noul', instructions: 'Urgent?'}}});
  assert.equal(evaluated.answers.urgent.noul, 0.9);
  assert.equal(JSON.stringify(evaluated).includes('synthetic-jev-key'), false);
  assert.deepEqual(await b.call('/api/jev', 'DELETE'), { configured: false });
  assert.deepEqual(await a.call('/api/jev'), { configured: false });
  // New-session inventories must follow the selected computer from either browser host.
  for (const browser of [a, b]) {
    for (const [owner, model] of [[a, 'model-a'], [b, 'model-b']]) {
      const choices = await browser.call(`/api/execution-models?app=__harness&host=${owner.status.self}`);
      assert.deepEqual(Object.keys(choices.models), [model]);
      assert.equal(choices.default, model);
    }
  }
  // Exercise the served frontend with reordered status replies and tab switches.
  const frontend = await (await a.request('/app.js')).text();
  const classes = new Set(), pendingStatus = [];
  const pushButton = { classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); } } };
  const ui = vm.createContext({ state: { session: { id: 'first' } },
    $: () => pushButton,
    api: route => new Promise((resolve, reject) => pendingStatus.push({ route, resolve, reject })),
  });
  vm.runInContext(frontend.slice(frontend.indexOf('const pushStates ='), frontend.indexOf('async function refreshState()')), ui);
  const oldStatus = ui.readPushStatus('first');
  const newStatus = ui.readPushStatus('first');
  pendingStatus[1].resolve({ pending: true, busy: false }); await newStatus;
  pendingStatus[0].resolve({ pending: false, busy: false }); await oldStatus;
  assert.ok(classes.has('push-pending'), 'older clean response cannot overwrite newer pending changes');
  const busyStatus = ui.readPushStatus('first');
  pendingStatus[2].resolve({ pending: false, busy: true }); await busyStatus;
  assert.ok(classes.has('push-pending'), 'temporary clean files during work do not flash the indicator');
  const failedStatus = ui.refreshPushStatus();
  pendingStatus[3].reject(new Error('offline')); await failedStatus;
  assert.ok(classes.has('push-pending'), 'network failure preserves last known pending state');
  assert.match(pushButton.title, /unavailable/);
  ui.state.session = { id: 'second' }; ui.paintPushStatus();
  assert.ok(!classes.has('push-pending'), 'different session never inherits pending state');
  ui.state.session = { id: 'first' }; ui.paintPushStatus();
  assert.ok(classes.has('push-pending'), 'returning to a session restores its known state immediately');
  const cleanStatus = ui.readPushStatus('first');
  pendingStatus[4].resolve({ pending: false, busy: false }); await cleanStatus;
  assert.ok(!classes.has('push-pending'), 'confirmed idle status clears pending changes');
  // A sheet opened during a turn must still accept a click after that turn.
  const gitNodes = new Map(['s-git', 'g-now', 'g-push-status'].map(id => [id, {
    innerHTML: '', textContent: '', classList: { toggle() {} }, insertAdjacentHTML() {},
  }]));
  let publishCalls = 0;
  const panel = vm.createContext({
    state: { session: { id: 'panel' } }, $: id => gitNodes.get(id),
    esc: String, clock: String, showBanner() {},
    api: async route => {
      if (route.startsWith('/api/git/push?')) {
        publishCalls++;
        throw new Error('Finish the current task before pushing');
      }
      return { repo: true, pending: true, busy: true, history: [] };
    },
  });
  vm.runInContext(frontend.slice(frontend.indexOf('const pushStates ='), frontend.indexOf('async function refreshState()')), panel);
  vm.runInContext(frontend.slice(frontend.indexOf('async function paintGit('), frontend.indexOf('/** Repoint a session')), panel);
  await panel.paintGit(panel.state.session);
  assert.equal(gitNodes.get('g-now').disabled, false, 'busy snapshot does not leave an inert button');
  await gitNodes.get('g-now').onclick();
  assert.equal(publishCalls, 1, 'click checks current server state');
  assert.match(gitNodes.get('g-push-status').textContent, /Not published: Finish the current task/);
  assert.equal(gitNodes.get('g-now').disabled, false, 'refused push can be retried without reopening');
  const state = await a.call('/api/state');
  assert.equal(state.apps.find(app => app.id === '__harness').executionHosts.length, 2);
  const s = await a.call('/api/sessions', 'POST', { appId: '__harness', name: 'remote', mode: 'chat', model: 'model-b', ownerNode: b.status.self });
  const inventory = await a.call(`/api/sessions/${s.id}/models`);
  assert.deepEqual(Object.keys(inventory.models), ['model-b'], 'models stay local to the owner');
  const events = await a.request(`/api/sessions/${s.id}/events`);
  const reader = events.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /hello/);
  await reader.cancel();
  await a.call(`/api/sessions/${s.id}/send`, 'POST', { text: 'wait' });
  for (let i = 0; i < 80 && !release; i++) await pause();
  assert.ok(release, 'a follower executed the model request');
  const activeState = await a.call('/api/state');
  const activeSession = activeState.sessions.find(row => row.id === s.id);
  assert.equal(activeSession.turnHost, b.status.self);
  assert.ok(activeSession.lastMessageAt > 0);
  const ordering = vm.createContext({ state: { busy: activeState.running } });
  vm.runInContext(frontend.slice(frontend.indexOf('function sessionActive('), frontend.indexOf('function paintSessionTabs(')), ordering);
  const rows = [
    { id: 'recent', lastMessageAt: activeSession.lastMessageAt + 100 },
    { id: 'renamed', lastMessageAt: 1, updatedAt: Date.now() + 10000 },
    activeSession,
  ].sort(ordering.sessionOrder);
  assert.equal(rows[0].id, s.id, 'remote active session sorts first');
  assert.equal(rows[1].id, 'recent', 'message time wins over incidental saves');

  ordering.state.sessions = [
    { id: 'do-tab', appId: '__harness', lastMessageAt: 1 },
    { id: 'grocery-old', appId: 'grocery', lastMessageAt: 2 },
    { id: 'grocery-new', appId: 'grocery', lastMessageAt: 30 },
    { id: 'other-tab', appId: 'other', lastMessageAt: 20, updatedAt: 100, turnHost: 'busy-host' },
  ];
  vm.runInContext(frontend.slice(frontend.indexOf('function orderProjects('), frontend.indexOf('let peerCatalog')), ordering);
  const projects = [
    { id: 'other', name: 'Other', running: true },
    { id: 'grocery', name: 'Grocery', running: false },
    { id: '__harness', name: 'DO', builtin: true },
  ];
  assert.deepEqual(Array.from(ordering.orderProjects(projects), p => p.id), ['__harness', 'grocery', 'other']);
  let projectHtml;
  const elements = new Map();
  Object.assign(ordering, {
    sheetView: 'apps', esc: String, shortDir: String, clock: String,
    sessionStatus: () => '', showPeerSessions() {},
    $: id => {
      if (!elements.has(id)) elements.set(id, { scrollTop: 0, querySelectorAll: () => [] });
      return elements.get(id);
    },
    openSheet: html => { projectHtml = html; },
  });
  vm.runInContext(frontend.slice(frontend.indexOf('function renderAppsSheet('), frontend.indexOf('async function runApp(')), ordering);
  ordering.renderAppsSheet({ apps: projects });
  assert.ok(projectHtml.indexOf('data-app-toggle="__harness"') < projectHtml.indexOf('data-app-toggle="grocery"'));
  assert.ok(projectHtml.indexOf('data-app-toggle="grocery"') < projectHtml.indexOf('data-app-toggle="other"'));
  assert.doesNotMatch(projectHtml, /data-open=|Working now|Recently messaged/);

  assert.ok((await a.call('/api/state')).running.includes(s.id));
  assert.equal((await a.request(`/api/sessions/${s.id}/machine`, 'POST', { ownerNode: a.status.self })).status, 409);
  const parallel = await a.call('/api/sessions', 'POST', { appId: '__harness', name: 'parallel', mode: 'chat', model: 'model-a', ownerNode: a.status.self });
  await b.call(`/api/sessions/${parallel.id}/send`, 'POST', { text: 'hello' });
  let parallelResult;
  for (let i = 0; i < 80; i++) {
    parallelResult = await a.call(`/api/sessions/${parallel.id}`);
    if (!parallelResult.turnHost && parallelResult.events.some(e => e.type === 'assistant')) break;
    await pause();
  }
  assert.ok(parallelResult.events.some(e => e.type === 'assistant'));
  assert.ok((await a.call('/api/state')).running.includes(s.id), 'another tab completes while the first is busy');
  assert.equal((await a.call('/api/state')).projectQueues, undefined);
  release();
  let finished;
  for (let i = 0; i < 80; i++) {
    finished = await a.call(`/api/sessions/${s.id}`);
    if (!finished.turnHost) break;
    await pause();
  }
  assert.ok(!finished.turnHost);
  assert.equal(finished.ownerNode, b.status.self);
  assert.ok(finished.events.some(e => e.type === 'assistant' && e.text === 'model-b'));
  assert.equal((await a.request(`/api/sessions/${s.id}/rewind`, 'POST', { eventId: finished.events[0].id, revertFiles: true })).status, 409, 'file rewind cannot bypass publication order');
  const stale = structuredClone(finished);
  const moved = await a.call(`/api/sessions/${s.id}/machine`, 'POST', { ownerNode: a.status.self });
  assert.equal(moved.ownerNode, a.status.self);
  assert.equal(moved.model, 'model-a');
  // Test only synthetic credentials in this test's temporary directory.
  const identity = JSON.parse(await fs.readFile(path.join(a.dir, 'cluster', 'replica.json'), 'utf8'));
  const late = await fetch(a.status.hosts[0].url + '/api/cluster/worker-save', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cluster-key': identity.secret },
    body: JSON.stringify({ host: b.status.self, session: stale }) });
  assert.equal(late.status, 409, 'a delayed previous-owner write cannot undo assignment');
  assert.equal((await a.call(`/api/sessions/${s.id}`)).ownerNode, a.status.self);
  assert.equal((await a.request('/api/cluster/worker-save', 'POST', { host: a.status.self, session: moved })).status, 403);
  // A restarted worker may never have been offline long enough for the
  // coordinator's liveness timeout. Simulate its persisted abandoned turn.
  const abandoned = { ...stale, id: 'abandoned-worker-turn', turnHost: b.status.self,
    turnStartedAt: 123, executionEpoch: 0 };
  const seeded = await fetch(a.status.hosts[0].url + '/api/cluster/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cluster-key': identity.secret },
    body: JSON.stringify({ type: 'session', id: abandoned.id, value: abandoned }),
  });
  assert.equal(seeded.status, 200);
  let recovered;
  for (let i = 0; i < 80; i++) {
    recovered = await a.call('/api/sessions/' + abandoned.id);
    if (!recovered.turnHost) break;
    await pause();
  }
  assert.ok(!recovered.turnHost, 'an online worker recovers its own abandoned turn');
  assert.equal(recovered.executionEpoch, 1);
  assert.equal(recovered.ownerNode, b.status.self);
  assert.ok(recovered.events.some(e => /nothing was automatically published or replayed/.test(e.text || '')));
  assert.equal((await a.call('/api/sessions/' + s.id)).ownerNode, a.status.self);
  const project = await a.call('/api/apps', 'POST', { name: 'local only', dir: path.join(root, 'local-project'), hosts: [a.status.self] });
  const disallowed = await b.request('/api/sessions', 'POST', { appId: project.id, model: 'model-b', ownerNode: b.status.self });
  assert.equal(disallowed.status, 400);
  const local = await b.call('/api/sessions', 'POST', { appId: project.id, mode: 'chat', model: 'model-a' });
  assert.equal(local.ownerNode, a.status.self, 'another computer can create a tab on the only enabled owner');
  const dependency = { host: a.status.self, alias: 'model-a', label: 'Analysis model', purpose: 'Product analysis' };
  await b.call('/api/apps/' + project.id, 'PATCH', { aiDependencies: [dependency] });
  await a.call('/api/apps/' + project.id, 'PATCH', { aiDependencies: [{ ...dependency, host: b.status.self }] });
  const wrongHostLaunch = await a.request('/api/apps/' + project.id + '/start', 'POST');
  assert.equal(wrongHostLaunch.status, 400);
  assert.match((await wrongHostLaunch.json()).error, /source computer/);
  await a.call('/api/apps/' + project.id, 'PATCH', { aiDependencies: [dependency] });
  const configured = await a.call('/api/apps');
  assert.deepEqual(configured.apps.find(app => app.id === project.id).aiDependencies, [dependency]);
  const blockedRemoval = await a.request('/api/cluster/sources', 'POST', { host: a.status.self, action: 'remove', alias: 'model-a' });
  assert.equal(blockedRemoval.status, 400);
  assert.match((await blockedRemoval.json()).error, /Used by local only/);
  const invalidDependency = await b.request('/api/apps/' + project.id, 'PATCH', { aiDependencies: [{ purpose: 'missing source' }] });
  assert.equal(invalidDependency.status, 400);

  const creation = await b.call(`/api/git?session=${local.id}&history=1`);
  assert.equal(creation.projectName, 'local only');
  assert.equal(creation.repositoryName, 'local-only');
  assert.equal(creation.createRepository, true);
  assert.ok(!creation.remote);
  const invalidVisibility = await b.request(`/api/git/push?session=${local.id}`, 'POST', { session: local.id, visibility: 'invalid' });
  assert.equal(invalidVisibility.status, 400);

  assert.equal((await b.call(`/api/sessions/${local.id}/models`)).default, 'model-a');
  await b.call(`/api/sessions/${local.id}/send`, 'POST', { text: 'hello' });
  for (let i = 0; i < 80; i++) {
    const value = await b.call(`/api/sessions/${local.id}`);
    if (!value.turnHost) { assert.ok(value.events.some(e => e.text === 'model-a')); break; }
    await pause();
  }
  assert.equal((await a.request(`/api/sessions/${local.id}/machine`, 'POST', { ownerNode: b.status.self })).status, 409);
  // Legacy durable queue values cannot block new turns or replay old requests.
  const legacy = await fetch(a.status.hosts[0].url + '/api/cluster/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cluster-key': identity.secret },
    body: JSON.stringify({ type: 'value', id: 'turn-queue:__harness', value: { next: 2, entries: [
      { id: 'old', sessionId: s.id, owner: a.status.self, state: 'blocked', number: 1 },
    ] } }),
  });
  assert.equal(legacy.status, 200);
  await a.call(`/api/sessions/${s.id}/send`, 'POST', { text: 'continue without a queue' });
  for (let i = 0; i < 80; i++) {
    const value = await a.call(`/api/sessions/${s.id}`);
    if (!value.turnHost && value.events.some(e => e.text === 'continue without a queue')
      && !(await a.call('/api/state')).running.includes(s.id)) break;
    await pause();
  }
  // Pending summaries include committed, unstaged and untracked session work.
  const summaryDir = path.join(root, 'summary-project');
  await fs.mkdir(summaryDir);
  const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', ...args], { cwd: dir, stdio: 'pipe' });
  git(summaryDir, 'init', '-b', 'main');
  await fs.writeFile(path.join(summaryDir, 'README.md'), 'original');
  git(summaryDir, 'add', '.'); git(summaryDir, 'commit', '-m', 'initial');
  const summarySession = await a.call('/api/sessions', 'POST', { name: 'summary', projectDir: summaryDir, model: 'model-a' });
  await prepareTab(summarySession);
  const work = summarySession.tabWorkspace.dir;
  // Push prepares public AI requirements in the isolated worktree, even if
  // project validation subsequently blocks publication.
  summarySession.appId = project.id;

  await fs.writeFile(path.join(work, 'README.md'), 'saved documentation');
  git(work, 'commit', '-am', 'documentation');
  await fs.mkdir(path.join(work, 'server/public'), { recursive: true });
  await fs.writeFile(path.join(work, 'server/public/app.js'), 'new interface');
  const seededSummary = await fetch(a.status.hosts[0].url + '/api/cluster/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cluster-key': identity.secret },
    body: JSON.stringify({ type: 'session', id: summarySession.id, value: summarySession }),
  });
  assert.equal(seededSummary.status, 200);
  const summary = await b.call(`/api/git?session=${summarySession.id}&history=1`);
  assert.equal(summary.pending, true);
  assert.match(summary.summary, /documentation/);
  assert.match(summary.summary, /interface/);
  assert.match(summary.summary, /2 files/);
  assert.equal(summary.machine, 'model-a', 'summary comes from the session owner');
  const attempted = await a.request('/api/git/push?session=' + summarySession.id, 'POST', { session: summarySession.id });
  assert.equal(attempted.status, 409, 'missing project checks still prevent publication');
  const readme = await fs.readFile(path.join(work, 'README.md'), 'utf8');
  assert.match(readme, /AI requirements/);
  assert.match(readme, /Analysis model/);
  assert.match(readme, /HARNESS_APP_AI/);
  assert.ok(!readme.includes(dependency.host), 'private machine IDs are excluded from public requirements');

  // Check the instructions actually delivered to a model by a project turn.
  const traceDir = path.join(root, 'tracing-project');
  await fs.mkdir(traceDir);
  const traceSession = await a.call('/api/sessions', 'POST', { name: 'tracing', projectDir: traceDir, mode: 'agent', model: 'model-a' });
  await a.call(`/api/sessions/${traceSession.id}/send`, 'POST', { text: 'check project tracing' });
  let traceResult;
  for (let i = 0; i < 80; i++) {
    traceResult = await a.call(`/api/sessions/${traceSession.id}`);
    if (!traceResult.turnHost && traceResult.events.some(e => e.type === 'assistant')) break;
    await pause();
  }
  assert.ok(traceResult.events.some(e => e.type === 'assistant'));
  const traceRequest = modelRequests.find(r => r.messages.at(-1)?.content === 'check project tracing');
  assert.ok(traceRequest, 'project request reached provider');
  const instructions = traceRequest.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  assert.match(instructions, /Jev \(TypeSafe\)/);
  assert.match(instructions, /api\/jev\/evaluate/);
  assert.match(instructions, /Tracing for future AI work/);
  assert.match(instructions, /screen or state actually shown/);
  assert.match(instructions, /inspect the relevant recent traces before guessing/);
  assert.match(instructions, /Do not record secrets/);
  const chatRequest = modelRequests.find(r => r.messages.at(-1)?.content === 'wait');
  assert.ok(chatRequest);
  assert.doesNotMatch(JSON.stringify(chatRequest.messages), /Tracing for future AI work/);

  await a.call(`/api/sessions/${s.id}`, 'DELETE');
  b.child.kill('SIGTERM');
  await b.closed;
  const unavailable = await a.request(`/api/execution-models?app=__harness&host=${b.status.self}`);
  assert.ok(!unavailable.ok, 'an offline computer never falls back to the serving computer’s models');
  assert.equal((await unavailable.json()).models, undefined);
  console.log('PASS follower-owned turns, local model inventories, SSE proxy, busy assignment guard, single-host eligibility and commands from another computer');
} finally {
  release?.();
  for (const h of hosts) if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill('SIGTERM');
  await Promise.all(hosts.map(h => h.closed));
  mock.closeAllConnections(); await new Promise(r => mock.close(r));
  await fs.rm(root, { recursive: true, force: true });
}
