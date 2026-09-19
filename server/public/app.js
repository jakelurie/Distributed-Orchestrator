/* Distributed Orchestrator, phone edition. Talks to the same core the desktop app drives. */

// Each page targets one execution machine. Never retry a mutation on another node.
const executionNode = new URLSearchParams(location.search).get('node') || '';
const nativeFetch = window.fetch.bind(window);
const nodeApi = (url) => executionNode && url.startsWith('/api/') && !url.startsWith('/api/nodes')
  ? `/api/nodes/${encodeURIComponent(executionNode)}${url}` : url;
const fetch = (url, options) => nativeFetch(typeof url === 'string' ? nodeApi(url) : url, {
  ...options, headers: { ...options?.headers,
    ...(typeof state !== 'undefined' && state.session?.id ? { 'x-harness-session': state.session.id } : {}),
  },
});
const sessionStorageKey = `lastSession${executionNode ? ':' + executionNode : ''}`;
let executionName = executionNode ? 'remote machine' : '';
if (executionNode) nativeFetch('/api/nodes').then((r) => r.json()).then((nodes) => {
  executionName = nodes.find((n) => n.id === executionNode)?.name || 'remote machine';
  paintHeader();
}).catch(() => {});

const $ = (id) => document.getElementById(id);

// Anything that throws where nobody is catching used to vanish and leave a
// dead-looking UI. Surface it instead.
window.addEventListener('unhandledrejection', (e) => {
  showBanner(e.reason?.message ?? String(e.reason));
});
window.addEventListener('error', (e) => showBanner(e.message));
const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
};

// The open session owns its transcript and stream.
const tabs = {
  chat: { session: null, stream: null, running: false, live: null, startedAt: null },
};

const state = {
  models: {}, default: null, sessions: [], beacons: {},
  session: null,          // the currently open session
  home: '',
  tab: 'chat',
};

const cur = () => tabs[state.tab];

// Images chosen but not yet sent. Uploaded immediately so the send is quick and
// so a failed conversion is visible before you commit to the message.
let pendingShots = [];

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Enough markdown to read like prose rather than source. Headings, bold, lists
 * and code - not a full parser, because anything it does not recognise should
 * survive as literal text rather than disappear.
 */
function render(text) {
  const parts = String(text ?? '').split(/```/);
  return parts
    .map((chunk, i) => {
      if (i % 2) {
        const body = chunk.replace(/^[\w+-]*\n/, '');
        return `<pre><code>${esc(body)}</code></pre>`;
      }
      return inline(chunk);
    })
    .join('');
}

function inline(chunk) {
  const lines = esc(chunk).split('\n');
  const out = [];
  let list = null;

  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };
  const openList = (tag) => {
    if (list !== tag) { closeList(); out.push(`<${tag}>`); list = tag; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);

    if (heading) {
      closeList();
      const level = Math.min(4, heading[1].length + 2); // h1 in a chat is shouting
      out.push(`<h${level}>${emphasis(heading[2])}</h${level}>`);
    } else if (bullet) {
      openList('ul');
      out.push(`<li>${emphasis(bullet[1])}</li>`);
    } else if (numbered) {
      openList('ol');
      out.push(`<li>${emphasis(numbered[1])}</li>`);
    } else if (!line.trim()) {
      closeList();
      out.push('<br>');
    } else {
      closeList();
      out.push(`${emphasis(line)}<br>`);
    }
  }
  closeList();
  return out.join('');
}

/** Applied to already-escaped text, so it can only add the markup it intends. */
function emphasis(t) {
  return t
    // Markdown links. A model handing back a file writes one constantly, and
    // unrendered they spill an absolute path across several lines.
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      // Only schemes that are safe to put in an href; a local path becomes a
      // preview link into the orchestrator rather than a dead file:// URL.
      if (/^https?:\/\//i.test(href)) {
        return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
      }
      if (href.startsWith('/')) {
        return `<a href="${nodeApi('/api/file')}?path=${encodeURIComponent(href)}&session=${encodeURIComponent(state.session?.id || '')}" target="_blank" rel="noopener">${label}</a>`;
      }
      return label;   // relative or unknown: show the words, drop the link
    })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}

/** Local date and time, so chats from different days are distinguishable. */
const clock = (ts) => (ts
  ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  : '');

const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

const shortDir = (p) => String(p ?? '').replace(state.home, '~');

// ------------------------------------------------------------------ sheet

// Which sheet is showing. A slow fetch that lands after you have moved on
// must not redraw over the sheet you are now looking at.
let sheetView = null;

function openSheet(html, view = null) {
  sheetView = view;
  $('sheet').innerHTML = html;
  $('sheet-back').hidden = false;
}
function closeSheet() {
  sheetView = null;
  $('sheet-back').hidden = true;
  $('sheet').innerHTML = '';
}

// ------------------------------------------------------------- transcript

/**
 * @param reveal  show the output without a tap. Used when the assistant said
 *                nothing of its own: a collapsed tool call would otherwise be
 *                the entire reply, which reads as no answer at all.
 */
function toolBlock(call, result, reveal = false) {
  const status = !result
    ? '<span class="tool-status pending">running…</span>'
    : result.ok
      ? '<span class="tool-status ok">ok</span>'
      : '<span class="tool-status err">failed</span>';
  const arg = describe(call);
  const body = result
    ? `<pre class="tool-body"${reveal ? '' : ' hidden'}>${esc(result.output)}</pre>`
    : '';
  return `<div class="tool" data-call="${esc(call.id)}">
      <div class="tool-head"><span class="tool-name">${esc(call.name)}</span>
      <span class="tool-arg">${esc(arg)}</span>
      <span class="at">${clock(result?.ts)}</span>${status}</div>${body}</div>`;
}

function describe(call) {
  const a = call.args ?? {};
  switch (call.name) {
    case 'bash': return a.command ?? '';
    case 'read_file':
    case 'list_dir': return a.path ?? '.';
    case 'write_file': return `${a.path ?? ''} (${String(a.content ?? '').split('\n').length} lines)`;
    case 'edit_file': return a.path ?? '';
    default: return JSON.stringify(a).slice(0, 120);
  }
}

/**
 * The plain text behind each reply, so it can be copied out and pasted into
 * another session as context.
 *
 * Kept in a map rather than a data- attribute because `esc` above deliberately
 * leaves quotes alone, and a reply containing one would break out of the
 * attribute. The map is rebuilt with the transcript, so it cannot drift from
 * what is on screen or grow without bound.
 */
const copyTexts = new Map();

/**
 * Copy text, on a phone, over both of the ways this harness is reached.
 *
 * The async clipboard API exists only in a secure context. Over Tailscale that
 * is HTTPS and it works; over plain HTTP on the LAN `navigator.clipboard` is
 * simply undefined, so the old selection trick is kept as the path for that
 * rather than letting the button do nothing. iOS ignores a readonly textarea,
 * hence the contentEditable range dance.
 */
async function copyText(text) {
  // Neither route can write to the clipboard while the document is unfocused,
  // and `execCommand` will still cheerfully return true when it wrote nothing.
  // Checking first is what keeps the button from claiming a copy that did not
  // happen - a button that lies is worse than one that says it could not.
  if (!document.hasFocus()) {
    window.focus();
    if (!document.hasFocus()) return false;
  }

  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* denied or unavailable - fall through */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.contentEditable = 'true';
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  try {
    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ta.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

/** Last resort: put the reply under a selection so it can be copied by hand. */
function selectReply(button) {
  const body = button.closest('.turn.assistant')?.querySelector('.body');
  if (!body) return;
  const range = document.createRange();
  range.selectNodeContents(body);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * A turn is what a person actually thinks in: something I asked, some work, an
 * answer. The event log is flatter than that - assistant, tool_result,
 * assistant, tool_result - so it gets regrouped here.
 */
function turnsFrom(events) {
  const turns = [];
  let cur = null;
  const start = (user) => {
    cur = { user, steps: [], texts: [], notes: [], files: [], model: null, endedOn: null };
    turns.push(cur);
    return cur;
  };

  for (const e of events) {
    if (e.type === 'user') { start(e); continue; }
    if (!cur) start(null);

    if (e.type === 'assistant') {
      cur.model = e.model || cur.model;
      if (e.text?.trim()) { cur.texts.push(e); cur.endedOn = 'reply'; }
      for (const c of e.toolCalls ?? []) cur.steps.push({ call: c, result: null });
    } else if (e.type === 'tool_result') {
      const step = cur.steps.find((x) => x.call.id === e.callId && !x.result);
      if (step) step.result = e;
      else cur.steps.push({ call: { id: e.callId, name: e.name, args: {} }, result: e });
      cur.endedOn = 'tool';
    } else if (e.type === 'note') {
      cur.notes.push(e);
    } else if (e.type === 'files') {
      cur.files.push(...(e.files ?? []));
    }
  }
  return turns;
}

/**
 * One chip for a whole turn's work.
 *
 * Deliberately not a progress bar: an agent turn has no known length, so a bar
 * would have to invent a denominator and would lie. A chip that pulses while
 * work is happening says the true thing - something is going on - and the
 * colour says how it is going.
 *
 * Green while it is getting somewhere, red only when a failure actually ended
 * the turn: a command that failed and was then worked around is not something
 * to alarm the user about. Amber marks that recovery, because "it worked, but
 * not first try" is worth knowing and is neither of the other two.
 */
function activityChip(turn, key, running) {
  const total = turn.steps.length;
  if (!total) return '';

  const done = turn.steps.filter((s) => s.result).length;
  const failures = turn.steps.filter((s) => s.result && !s.result.ok).length;
  const last = turn.steps[total - 1];
  const endedBadly = !running && last?.result && !last.result.ok;

  // A turn that ran tools and then said nothing is not the same as one that
  // finished and explained itself. Without this it reads as "done, fine,
  // nothing to see" while the answer sits collapsed two taps away.
  const silent = !running && !turn.texts.length;

  const tone = endedBadly ? 'bad' : failures ? 'warn' : silent ? 'warn' : 'ok';
  const label = running
    ? 'working'
    : endedBadly
      ? `stopped on ${esc(last.call.name)}`
      : silent
        ? `${done} step${done === 1 ? '' : 's'} · no summary, output below`
        : failures
          ? `${done} steps · ${failures} recovered`
          : `${done} step${done === 1 ? '' : 's'}`;

  return `<button class="act ${tone}${running ? ' live' : ''}" data-act="${key}">
      <span class="act-dot"></span>
      <span class="act-label">${label}</span>
      <span class="act-at">${clock(turn.steps[0]?.result?.ts ?? turn.user?.ts)}</span>
      <span class="act-caret">${silent ? '▴' : '▾'}</span>
    </button>
    <div class="act-detail" id="act-${key}"${silent ? '' : ' hidden'}>
      ${turn.steps.map((s, i) => toolBlock(s.call, s.result, silent && i === total - 1)).join('')}
    </div>`;
}

/**
 * What one question cost.
 *
 * A backend that streams its own agent loop reports fragments per message and
 * the real total once at the end, flagged. When that flag is present it is the
 * answer; otherwise every message carried its own true figure and they sum.
 */
function turnUsage(turn) {
  const authoritative = turn.texts.find((a) => a.usage?.total)
    ?? [...turn.texts].reverse().find((a) => a.usage?.total);
  if (authoritative) return authoritative.usage;

  return turn.texts.reduce((acc, a) => ({
    input: acc.input + (a.usage?.input ?? 0),
    cached: acc.cached + (a.usage?.cached ?? 0),
    output: acc.output + (a.usage?.output ?? 0),
    ms: acc.ms + (a.usage?.ms ?? 0),
  }), { input: 0, cached: 0, output: 0, ms: 0 });
}

/**
 * Which turns are open.
 *
 * Keyed by the user message's own id rather than a position, because the
 * transcript re-renders on every streamed event and an index-keyed set would
 * silently reassign what the reader had opened. Progress opens while running
 * and closes on completion unless the reader chose otherwise.
 */
const openedFolds = new Set();
const closedFolds = new Set();

const foldKey = (turn, i) => turn.user?.id ?? `t${i}`;

function foldIsOpen(turn, i, isLast, running) {
  const key = foldKey(turn, i);
  if (openedFolds.has(key)) return true;
  if (closedFolds.has(key)) return false;
  return running; // completed progress closes independently of the final reply
}

/** One line describing everything a question set off. */
function foldSummary(turn, running) {
  const steps = turn.steps.length;
  const done = turn.steps.filter((s) => s.result).length;
  const failures = turn.steps.filter((s) => s.result && !s.result.ok).length;
  const last = turn.steps[steps - 1];
  const endedBadly = !running && last?.result && !last.result.ok;
  const silent = !running && steps > 0 && !turn.texts.length;

  // A turn that stopped straight after a tool, with no closing message, is the
  // case that reads as "still going" when it is not. Name it.
  const stoppedShort = !running && turn.endedOn === 'tool';

  const tone = endedBadly ? 'bad' : (failures || silent || stoppedShort) ? 'warn' : 'ok';
  const parts = [];
  if (running) {
    parts.push('working');
  } else if (endedBadly) {
    parts.push(`stopped on ${esc(last.call.name)}`);
  } else {
    // "done" first, so the state is the first thing read rather than inferred.
    parts.push(stoppedShort ? 'ended without a summary' : 'done');
    if (turn.texts.length) parts.push(`${turn.texts.length} repl${turn.texts.length === 1 ? 'y' : 'ies'}`);
    if (steps) parts.push(`${done} step${done === 1 ? '' : 's'}`);
    if (failures) parts.push(`${failures} recovered`);
    if (silent) parts.push('output below');
  }
  // A turn that produced nothing at all is not a green outcome.
  const empty = !running && !turn.texts.length && !turn.steps.length;
  return { tone: empty ? 'warn' : tone, text: parts.join(' · ') };
}

/**
 * Per-message controls: take it out of the context, or wind back to it.
 *
 * Both edit what the model will be sent next turn, which is why they live on
 * the message itself rather than in a menu somewhere: the thing being changed
 * is the thing you are looking at.
 */
function messageActions(eventId, { rewind = false } = {}) {
  return `<span class="msg-acts">${rewind
    ? `<button class="msg-act" data-rewind="${esc(eventId)}" aria-label="Rewind the conversation to this message" title="Rewind to here">${ICON_REWIND}</button>` : ''}
    <button class="msg-act" data-erase="${esc(eventId)}" aria-label="Delete this message from the conversation" title="Delete">${ICON_TRASH}</button></span>`;
}

// Drawn in currentColor rather than emoji, so they take the theme's dim grey
// like the pills around them instead of arriving in their own colours.
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
const ICON_REWIND = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/></svg>';

function messageToggle(key, label) {
  const open = !closedFolds.has(key);
  return `<button class="message-toggle" data-fold="${esc(key)}" aria-label="Toggle ${label}" aria-expanded="${open}"><span class="act-caret">${open ? '▴' : '▾'}</span></button>`;
}

function turnCommitLink(turn) {
  const note = [...(turn.notes || [])].reverse().find(n =>
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/commit\/[a-f0-9]{7,40}$/i.test(n.commitUrl || ''));
  return note ? `<a class="turn-commit" href="${esc(note.commitUrl)}" target="_blank" rel="noopener noreferrer" aria-label="View this turn’s commit on GitHub">commit ↗</a>` : '';
}

function turnHtml(turn, i, running, number, isLast) {
  const key = foldKey(turn, i);
  const open = foldIsOpen(turn, i, isLast, running);
  const bits = [];

  if (turn.user) {
    const u = turnUsage(turn);
    const read = (u.input ?? 0) + (u.cached ?? 0);
    const cost = [];
    if (read) cost.push(`${compact(read)} in`);
    if (u.output) cost.push(`${compact(u.output)} out`);
    if (u.ms > 1500) cost.push(`${(u.ms / 1000).toFixed(0)}s`);

    bits.push(`<div class="turn user">
      <div class="who"><span class="qn">${turn.user.turnNumber ?? number}</span> you
        <span class="at">${clock(turn.user.ts)}</span>${turnCommitLink(turn)}${
  messageActions(turn.user.id, { rewind: true })}${messageToggle(key + '-input', 'your message')}</div>
      <div id="fold-${esc(key)}-input"${closedFolds.has(key + '-input') ? ' hidden' : ''}><div class="user-message">${esc(turn.user.text)}${
  (turn.user.attachments ?? []).length
    ? `<div class="shots">${turn.user.attachments.map((a) => (a.role === 'document'
      ? `<button class="file-card sent-doc" data-open-file="${esc(a.path)}" data-file-kind="${a.mime === 'application/pdf' ? 'pdf' : 'text'}">
           <span class="file-icon">${a.mime === 'application/pdf' ? '📕' : '📄'}</span>
           <span class="file-meta"><span class="file-name">${esc(a.name)}</span>
           <span class="file-sub">${humanSize(a.bytes ?? 0)}</span></span>
         </button>`
      : `<img src="${nodeApi('/api/file')}?path=${encodeURIComponent(a.path)}&session=${encodeURIComponent(state.session?.id || '')}" alt="${esc(a.name)}">`)).join('')}</div>`
    : ''}</div>
      ${cost.length ? `<div class="usage turn-cost">${cost.join(' · ')}</div>` : ''}</div></div>`);
  }

  // Only the terminal reply is final; earlier commentary belongs to progress.
  const finalIndex = !running && turn.endedOn === 'reply' && !turn.texts.at(-1)?.toolCalls?.length ? turn.texts.length - 1 : -1;
  let finalReply = '';
  const inner = [];
  for (const [j, a] of turn.texts.entries()) {
    const think = a.thinking ? `<div class="thinking">${esc(a.thinking)}</div>` : '';
    // The markdown source, not the rendered text: code fences and list markers
    // are exactly what makes it worth pasting somewhere else.
    const copyId = `${key}-${j}`;
    copyTexts.set(copyId, a.text);
    const isFinal = j === finalIndex;
    const replyKey = key + '-final';
    const reply = `<div class="turn assistant${isFinal ? ' final-reply' : ''}">
      <div class="who"><span class="tag">${esc(a.model)}</span>
        ${a.servedModel && a.servedModel !== a.model
          ? `<span class="served">${esc(a.servedModel)}</span>` : ''}
        <span class="at">${clock(a.ts)}</span>
        <button class="copy-reply" data-copy="${esc(copyId)}"
          aria-label="Copy this reply as plain text">copy</button>${messageActions(a.id)}${isFinal ? messageToggle(replyKey, 'final reply') : ''}</div>
      <div${isFinal ? ` id="fold-${esc(replyKey)}"${closedFolds.has(replyKey) ? ' hidden' : ''}` : ''}>${think}<div class="body">${render(a.text)}</div></div></div>`;
    if (isFinal) finalReply = reply; else inner.push(reply);
  }
  inner.push(activityChip(turn, key, running));
  for (const n of turn.notes) {
    const bad = /error|failed|not in models|stopped/i.test(n.text);
    inner.push(`<div class="note${bad ? ' error' : ''}">${esc(n.text)}</div>`);
  }

  const body = inner.join('').trim();

  const sum = foldSummary(turn, running);
  if (body) bits.push(`<button class="fold ${sum.tone}${running ? ' live' : ''}" data-fold="${esc(key)}">
      <span class="act-dot"></span>
      <span class="fold-label">Progress · ${sum.text}</span>
      <span class="act-caret">${open ? '▴' : '▾'}</span>
    </button>
    <div class="fold-body" id="fold-${esc(key)}"${open ? '' : ' hidden'}>${body}</div>`);

  bits.push(finalReply);

  return bits.join('');
}

function drawTranscript() {
  const s = cur().session;
  const el = $('transcript');
  if (!s) {
    el.innerHTML = '<div class="empty"><p>nothing open</p><p class="dim">tap ☰ for your apps &amp; sessions</p></div>';
    return;
  }
  if (!s.events.length) {
    el.innerHTML = `<div class="empty"><p>${esc(s.name)}</p><p class="dim">${esc(shortDir(s.projectDir))}</p><p class="dim">say what you want built</p></div>`;
    return;
  }
  const turns = turnsFrom(s.events);
  copyTexts.clear();
  let n = 0;
  el.innerHTML = turns
    .map((t, i) => turnHtml(
      t, i,
      cur().running && i === turns.length - 1,
      t.user ? (n += 1) : n,
      i === turns.length - 1,
    ))
    .join('');
  scrollDown();
}

let pinned = true;
function scrollDown(force = false) {
  const el = $('transcript');
  if (force || pinned) el.scrollTop = el.scrollHeight;
}

// Streaming: append into a scratch turn that is replaced by the real event.
function liveTurn(tab = state.tab) {
  const t = tabs[tab];
  if (!t.live) {
    const div = document.createElement('div');
    div.className = 'turn assistant';
    div.innerHTML = `<div class="who"><span class="tag">${esc(t.session?.model ?? '')}</span></div>
      <div class="thinking" hidden></div><div class="body"></div>`;
    if (tab === state.tab) $('transcript').append(div);
    t.live = div;
  }
  return t.live;
}
function clearLive(tab = state.tab) {
  tabs[tab].live?.remove();
  tabs[tab].live = null;
}

// ---------------------------------------------------------------- session

let openingSession = null;   // the tap we are still fetching for

async function openSession(id) {
  if (sessionOffline(state.sessions.find(s => s.id === id))) return showBanner('This tab’s computer is offline. Reconnect it to open the tab.');
  window.cancelDictation?.();
  openingSession = id;

  // Answer the tap before doing the work. Fetching a session pulls its whole
  // transcript down - a long one is a few hundred kilobytes even compressed -
  // and leaving the list sitting there until it arrived made the tap look like
  // it had been missed. The name and model are already known from the list,
  // so the header can be right immediately and only the body has to wait.
  closeSheet();
  const meta = state.sessions.find((x) => x.id === id);
  if (meta) {
    $('title-name').textContent = state.apps?.find((a) => a.id === meta.appId)?.name || 'Distributed Orchestrator';
    $('title-sub').textContent = `Model: ${state.models[meta.model]?.label || meta.model}`;
  }
  $('transcript').innerHTML = '<div class="empty"><p class="dim">loading…</p></div>';

  let session;
  try {
    session = await api(`/api/sessions/${id}`);
  } catch (e) {
    if (openingSession !== id) return;
    openingSession = null;
    showBanner(e.message);
    drawTranscript();     // back to whatever was open before
    return;
  }
  // Tapping a second session while the first is still coming: the later tap wins.
  if (openingSession !== id) return;
  openingSession = null;

  state.session = session;
  try { state.models = (await api(`/api/sessions/${id}/models`)).models; } catch { /* owner may reconnect */ }
  if (state.session?.id !== id) return;
  tabs.chat.session = session;
  localStorage.setItem(sessionStorageKey, id);
  if (session.appId) localStorage.setItem(`${sessionStorageKey}:app:${session.appId}`, id);

  clearLive('chat');
  showSession();
  listen('chat', id);
}

/**
 * Apply a delete or a rewind, and show the conversation as it now stands.
 *
 * The server returns the whole session rather than a patch: the transcript is
 * the thing that changed, and re-rendering from the truth is cheaper to reason
 * about than replaying the edit on the copy held here.
 */
async function editTranscript(verb, body) {
  // The transcript on screen belongs to the open tab, which is not always the
  // chat one — the monitor companion draws into the same view.
  const id = cur().session?.id;
  if (!id) return;
  try {
    const res = await api(`/api/sessions/${id}/${verb}`, { method: 'POST', body: JSON.stringify(body) });
    cur().session = res.session;
    if (state.session?.id === id) state.session = res.session;
    // A rewind is nearly always a prelude to asking for the same thing
    // differently, so the message comes back to the composer instead of being
    // thrown away with the turn it started.
    if (res.draft && !$('input').value.trim()) {
      $('input').value = res.draft;
      $('input').style.height = 'auto';
      $('input').style.height = `${Math.min($('input').scrollHeight, window.innerHeight * 0.4)}px`;
      paintComposerAction();
    }
    showSession();
    showBanner('');
  } catch (e) { showBanner(e.message, true); }
}

function nextTabName(appId) {
  const sessions = state.sessions.filter((s) => (s.appId ?? null) === (appId || null));
  let number = sessions.length + 1;
  for (const session of sessions) {
    const match = /^Tab (\d+)$/.exec(session.name);
    if (match) number = Math.max(number, Number(match[1]) + 1);
  }
  return `Tab ${number}`;
}

function projectSession(app) {
  const sessions = state.sessions.filter((s) => s.appId === app.id && !sessionOffline(s));
  const remembered = localStorage.getItem(`${sessionStorageKey}:app:${app.id}`);
  return sessions.find((s) => s.id === state.session?.id)
    || sessions.find((s) => s.id === remembered) || sessions[0];
}

const openingProjects = new Set();

async function openProject(app) {
  if (openingProjects.has(app.id)) return;
  openingProjects.add(app.id);
  try {
    let session = projectSession(app);
    if (!session) {
      if (state.sessions.some(s => s.appId === app.id)) return showBanner('This app’s tabs are on offline computers. Reconnect a computer to open its tabs.');
      session = await api('/api/sessions', { method: 'POST',
        body: JSON.stringify({ appId: app.id, name: nextTabName(app.id), model: state.default }) });
      state.sessions.unshift(session);
    }
    await openSession(session.id);
  } catch (e) { showBanner(e.message, true); }
  finally { openingProjects.delete(app.id); }
}

function sessionOffline(session) {
  if (!session || !state.machines?.hosts) return false;
  const owner = session.ownerNode || state.machines.leader;
  return Boolean(owner) && !state.machines.hosts.some(h => h.id === owner && h.active !== false);
}

function tabComputerBadge(session) {
  const app = state.apps?.find(a => a.id === session.appId);
  if ((app?.executionHosts?.length || 0) < 2) return '';
  const host = state.machines?.hosts?.find(h => h.id === (session.ownerNode || state.machines.leader));
  if (!host) return '';
  const label = esc(`Computer ${host.number}: ${host.name}`).replace(/"/g, '&quot;');
  return `<span class="tab-computer" title="${label}" aria-label="${label}"><svg viewBox="0 0 28 24" aria-hidden="true"><rect x="1" y="1" width="26" height="17" rx="2"/><path d="M14 18v5M8 23h12"/><text x="14" y="13">${host.number}</text></svg></span>`;
}

function paintSessionTabs() {
  const bar = $('session-tabs');
  if (!bar) return;
  const current = state.session;
  bar.hidden = !current;
  if (!current) { bar.innerHTML = ''; return; }
  const sessions = current.appId ? state.sessions.filter((s) => s.appId === current.appId) : [current];
  if (!sessions.some((s) => s.id === current.id)) sessions.push(current);
  // Keep offline tabs at the right, preserving creation order in each group.
  sessions.sort((a, b) => Number(sessionOffline(a)) - Number(sessionOffline(b)) || (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
  bar.innerHTML = `<div class="session-tab-list" aria-label="Sessions">${sessions.map((s) =>
    `<button class="ghost${s.id === current.id ? ' on' : ''}${sessionOffline(s) ? ' offline' : ''}" ${sessionOffline(s) ? 'disabled aria-label="' + esc(s.name) + ' · computer offline"' : ''} data-session-id="${esc(s.id)}" aria-current="${s.id === current.id ? 'page' : 'false'}" title="${esc(s.name)}${sessionOffline(s) ? ' · computer offline' : ''}"><span class="session-tab-name">${esc(s.name)}</span>${tabComputerBadge(s)}${(state.busy ?? []).includes(s.id) ? '<span class="session-busy-dot" role="img" aria-label="Working"></span>' : ''}</button>`).join('')}</div>
    <button class="tap" id="session-add" aria-label="New session" title="New session">＋</button>
    <button class="tap" id="session-options" aria-label="Session options" title="Session options">⋯</button>`;
  bar.querySelectorAll('[data-session-id]').forEach((el) => {
    el.onclick = () => { if (!el.disabled && el.dataset.sessionId !== state.session?.id) openSession(el.dataset.sessionId); };
  });
  $('session-add').onclick = () => { draft = { appId: current.appId }; newSheet(); };
  $('session-options').onclick = sessionOptionsSheet;
}

function sessionOptionsSheet() {
  const session = state.session;
  openSheet(`<h2>${esc(session.name)}</h2>
    <button class="rowlink" id="project-queue">Project turn queue <span>›</span></button>
    <button class="rowlink" id="session-edit">Edit session <span>›</span></button>
    <button class="rowlink" id="session-delete">Delete session <span>›</span></button>`);
  $('project-queue').onclick = projectQueueSheet;
  $('session-edit').onclick = sessionSettingsSheet;
  $('session-delete').onclick = async () => {
    if (!confirm('Delete this session?')) return;
    try {
      await api(`/api/sessions/${session.id}`, { method: 'DELETE' });
      state.sessions = state.sessions.filter((s) => s.id !== session.id);
      const next = state.sessions.find((s) => s.appId === session.appId);
      if (next) await openSession(next.id);
      else {
        tabs.chat.stream?.close();
        tabs.chat.session = state.session = null;
        clearLive('chat');
        showSession();
        appsSheet();
      }
    } catch (e) { showBanner(e.message, true); }
  };
}

async function projectQueueSheet() {
  const session = state.session;
  if (!session) return;
  await refreshState();
  const key = `turn-queue:${session.appId || session.id}`;
  const entries = state.projectQueues?.[key] || [];
  openSheet(`<h2>Project turn queue</h2>
    <p class="dim">Finished tabs integrate independently, merging and testing the latest code. Failed or offline turns do not hold other tabs. Send a follow-up to continue saved work, or retry publication here.</p>
    ${entries.map(e => `<div class="item"><div class="grow"><div class="t">#${e.number} · ${esc(e.name)}</div><div class="s">${esc(e.state)} · ${esc(state.machines?.hosts?.find(h => h.id === e.owner)?.name || 'computer')}</div><div class="s">${esc(e.detail || '')}</div></div>
      ${e.state === 'blocked' ? `<button class="ghost" data-retry-turn="${esc(e.sessionId)}">retry</button>` : ''}
      ${['queued', 'blocked'].includes(e.state) ? `<button class="ghost" data-skip-turn="${esc(e.id)}" data-turn-session="${esc(e.sessionId)}">skip</button>` : ''}</div>`).join('') || '<p class="dim">No turns queued yet.</p>'}
    <div class="actions"><button class="ghost" id="queue-refresh">refresh</button><button class="primary" id="queue-close">done</button></div>`);
  $('queue-close').onclick = closeSheet;
  $('queue-refresh').onclick = projectQueueSheet;
  $('sheet').querySelectorAll('[data-retry-turn]').forEach(button => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api(`/api/git/push?session=${encodeURIComponent(button.dataset.retryTurn)}`, { method: 'POST', body: JSON.stringify({ session: button.dataset.retryTurn }) });
        await projectQueueSheet();
      } catch (e) { showBanner(e.message); button.disabled = false; }
    };
  });
  $('sheet').querySelectorAll('[data-skip-turn]').forEach(button => {
    button.onclick = async () => {
      if (!confirm('Dismiss this failed or queued turn? Its unfinished files stay in its tab. Other tabs can already publish independently.')) return;
      button.disabled = true;
      try {
        await api(`/api/sessions/${button.dataset.turnSession}/skipturn`, { method: 'POST', body: JSON.stringify({ entryId: button.dataset.skipTurn }) });
        await projectQueueSheet();
      } catch (e) { showBanner(e.message); button.disabled = false; }
    };
  });
}

function showSession() {
  drawTranscript();
  paintHeader();
  paintSessionTabs();
  const t = cur();
  setRunning(t.running, t.startedAt);
  scrollDown(true);
}

function paintHeader() {
  const s = state.session;
  const t = cur();
  $('title-name').textContent = state.apps?.find((a) => a.id === s?.appId)?.name || 'Distributed Orchestrator';
  $('title-sub').textContent = s
    ? `Model: ${state.models[s.model]?.label || s.model}`
    : 'pick a session';
  $('send').disabled = !t.session;
  $('input').placeholder = idlePlaceholder();
  const model = s && state.models[s.model];
  if (s && s.projectDir === state.home) {
    showBanner('this session is rooted at your home folder — every project is in its scope. Use Edit session to give it its own directory.', true);
  } else if (s?.projectDirMissing) {
    showBanner(`${shortDir(s.projectDir)} no longer exists — use Edit session to choose another folder`, true);
  } else if (s && model && !model.hasKey) {
    showBanner(`${s.model} has no API key — tap ⚙ to add one`, true);
  } else {
    showBanner('');
  }
}

function showBanner(msg, warn = false) {
  const b = $('banner');
  b.textContent = msg;
  b.hidden = !msg;
  b.classList.toggle('warn', warn);
}

function paintComposerAction() {
  const busy = cur().running;
  const hasDraft = Boolean($('input').value.trim()) || pendingShots.length > 0;
  $('send').hidden = busy;
  $('stop').hidden = !busy || hasDraft;
  $('queue').hidden = !busy || !hasDraft;
}

function setRunning(on, startedAt = null, last = null, tab = state.tab) {
  const changed = tabs[tab].running !== on;
  tabs[tab].running = on;
  if (startedAt) tabs[tab].startedAt = startedAt;
  if (tab !== state.tab) return;   // background tab: remember, do not repaint
  paintComposerAction();
  $('working').hidden = !on;
  $('input').placeholder = on ? 'Write a follow-up, then tap Queue next…' : idlePlaceholder();
  if (on) startClock(startedAt); else stopClock();
  if (changed) drawTranscript();
}

const idlePlaceholder = () => 'Describe what to build…';



// A turn can be quiet for a long time. Show that it is alive, and for how long.
let clockFrom = 0;
let clockTimer = null;
function startClock(startedAt) {
  // Anchor on the server's start time so a reload continues the count instead
  // of restarting at zero and implying the turn just began.
  if (startedAt) clockFrom = startedAt;
  else if (!clockTimer) clockFrom = Date.now();
  const tick = () => {
    const s = Math.round((Date.now() - clockFrom) / 1000);
    $('working-time').textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };
  tick();
  clearInterval(clockTimer);
  clockTimer = setInterval(tick, 1000);
}
function stopClock() {
  clearInterval(clockTimer);
  clockTimer = null;
}

// Recover events missed while the browser was asleep. Keep the retry flag until
// a snapshot is applied, and never overwrite a different session or newer events.
async function recoverTranscript(tab) {
  const t = tabs[tab];
  if (!t.needsTranscript || t.recovering || !t.session) return;
  const session = t.session;
  const count = session.events.length;
  t.recovering = true;
  try {
    const fresh = await api(`/api/sessions/${session.id}`);
    if (t.session !== session || session.events.length !== count) return;
    t.session = fresh;
    t.needsTranscript = false;
    if (tab === 'chat') state.session = fresh;
    clearLive(tab);
    if (tab === state.tab) drawTranscript();
  } catch {
    // Reconciliation retries even after the composer has returned to idle.
  } finally {
    t.recovering = false;
  }
}

function listen(tab, id) {
  const t = tabs[tab];
  t.stream?.close();
  const es = new EventSource(nodeApi(`/api/sessions/${id}/events`));
  t.stream = es;

  es.onmessage = (msg) => {
    if (t.stream !== es) return;
    const p = JSON.parse(msg.data);
    const active = tab === state.tab;

    if (p.kind === 'hello') {
      t.needsTranscript = true;
      setRunning(p.running, p.startedAt, p.last, tab);
      recoverTranscript(tab);
      return;
    }

    if (p.kind === 'delta') {
      const d = p.delta;
      if (d.kind === 'text') {
        const body = liveTurn(tab).querySelector('.body');
        body.dataset.raw = (body.dataset.raw ?? '') + d.text;
        body.innerHTML = render(body.dataset.raw);
      } else if (d.kind === 'thinking') {
        const el = liveTurn(tab).querySelector('.thinking');
        el.hidden = false;
        el.textContent += d.text;
      } else if (d.kind === 'tool_start') {
        liveTurn(tab).insertAdjacentHTML('beforeend', toolBlock(d.call, null));
      } else if (d.kind === 'tool_end') {
        const el = liveTurn(tab).querySelector(`[data-call="${CSS.escape(d.result.callId)}"] .tool-status`);
        if (el) {
          el.className = `tool-status ${d.result.ok ? 'ok' : 'err'}`;
          el.textContent = d.result.ok ? 'ok' : 'failed';
        }
      }
      if (active) scrollDown();
      return;
    }

    if (p.kind === 'queue') setRunning(true, t.startedAt, `integrating turn #${p.number}`, tab);
    if (p.kind === 'started') setRunning(true, p.startedAt, null, tab);
    if (p.kind === 'event') {
      clearLive(tab);
      t.session?.events.push(p.event);
      if (active) drawTranscript();
      if (p.event.type === 'assistant') setRunning(true, t.startedAt || null, null, tab);
      return;
    }

    if (p.kind === 'error' && active) showBanner(p.error);

    if (p.kind === 'done') {
      clearLive(tab);
      setRunning(false, null, null, tab);
      t.startedAt = null;
      if (active) {
        // Repaint: the fold and chip were rendered in their running state and
        // would otherwise keep claiming "working" after the turn had ended.
        drawTranscript();
        refreshState();
      }
    }
  };
  es.onerror = () => {}; // EventSource reconnects on its own
}

async function send(queue = false) {
  if (window.dictationBusy?.()) return showBanner('Finish or cancel dictation before sending.');
  const text = $('input').value.trim();
  const shots = pendingShots.filter((a) => !a.uploading && a.path);
  if (!text && !shots.length) return;
  if (pendingShots.some((a) => a.uploading)) return showBanner('still uploading — one moment');
  const t = cur();
  if (!t.session) return showBanner('open a session first — tap ☰');
  if (t.running && !queue) return showBanner('Tap Queue next to send after this turn, or Stop to interrupt.');
  const sessionId = t.session.id;
  const draft = $('input').value;
  const button = $(queue ? 'queue' : 'send');
  if (button.disabled) return;
  button.disabled = true;
  if (!queue) setRunning(true);
  showBanner('');
  pinned = true;
  try {
    const result = await api(`/api/sessions/${sessionId}/${queue ? 'queue' : 'send'}`, {
      method: 'POST',
      body: JSON.stringify({
        text,
        attachments: shots.map(({ name, path, mime, bytes }) => ({ name, path, mime, bytes })),
      }),
    });
    if (cur().session?.id === sessionId) {
      if ($('input').value === draft) {
        $('input').value = '';
        $('input').style.height = 'auto';
      }
      pendingShots = pendingShots.filter(a => !shots.includes(a));
      paintPending();
      if (result.queued) showBanner('Message queued for this tab. Stop cancels the queued message too.');
    }
  } catch (e) {
    if (!queue && cur().session?.id === sessionId) setRunning(false);
    showBanner(e.message);
  } finally { button.disabled = false; }
}

// ------------------------------------------------------------------ menus

async function refreshState() {
  const s = await api('/api/state');
  // Assign field by field. A blanket Object.assign once let the server's
  // `running` (an array of busy session ids) land on top of the local boolean
  // of the same name - and [] is truthy, so send() silently refused forever.
  if (s.harnessUpdate?.restartRequired && state.harnessUpdateRevision !== s.harnessUpdate.head) {
    state.harnessUpdateRevision = s.harnessUpdate.head;
    showBanner('Harness code was updated on this computer. Use Restart on the Harness app to apply it.');
  }
  state.machines = s.machines;
  state.projectQueues = s.projectQueues || {};
  state.apps = s.apps ?? [];
  state.models = s.models ?? {};
  state.default = s.default;
  try {
    const inventory = await api(state.session?.id ? `/api/sessions/${state.session.id}/models` : '/api/models/catalog');
    if (inventory.models) state.models = inventory.models;
    if (inventory.default) state.default = inventory.default;
  } catch { /* the owner may be reconnecting */ }
  state.sessions = s.sessions ?? [];
  state.home = s.home ?? '';
  state.busy = s.running ?? [];
  state.beacons = s.beacons ?? {};
  if (s.error) showBanner(s.error);
  // Keep the composer honest if the page was reloaded mid-turn.
  // Reconcile the open session against the server's running turn.
  for (const [name, tab] of Object.entries(tabs)) {
    if (!tab.session) continue;
    const id = tab.session.id;
    const info = s.turns?.[id];
    const busy = state.busy.includes(id);

    // We thought a turn was running and the server says it is not: the end of
    // it was missed, so the transcript is short by however much arrived after
    // the connection dropped. Re-read it rather than showing a stale tail.
    if (tab.running && !busy) tab.needsTranscript = true;
    setRunning(busy, info?.startedAt ?? null, info?.last ?? null, name);
    recoverTranscript(name);
  }
  paintSessionTabs();
  return s;
}

function modelOptions(selected) {
  return Object.values(state.models)
    .map((m) => `<option value="${esc(m.alias)}"${m.alias === selected ? ' selected' : ''}>
      ${esc(m.label ?? m.alias)}${m.hasKey ? '' : ' — no key'}</option>`)
    .join('');
}

/**
 * What a session is doing, at a glance in the browser.
 *
 * Three states worth telling apart: working, waiting on you, and working but
 * gone quiet for longer than its backend should. The last one matters because
 * an agent CLI can be silent for a long time legitimately, so it is reported as
 * "quiet" rather than as a failure.
 */
function sessionStatus(s) {
  // `busy`, not `running`: a local boolean already owns that name here.
  const running = (state.busy ?? []).includes(s.id);
  if (!running) return '<span class="sstat waiting">waiting for you</span>';
  const b = state.beacons?.[s.id];
  if (b?.stalled) {
    return `<span class="sstat quiet">quiet ${Math.round(b.silentMs / 60000)}m</span>`;
  }
  const what = b?.lastActivity ? String(b.lastActivity).split(/\s+/)[0] : '';
  return `<span class="sstat thinking"><span class="pulse"></span>thinking${what ? ` · ${esc(what)}` : ''}</span>`;
}

// Sessions and apps live in one view (see appsSheet). Kept as an alias so
// existing callers that refresh the list still work.
async function sessionsSheet() { return appsSheet(); }

let draft = {};   // survives a detour through the directory browser

async function newSheet() {
  await refreshState();
  // Each session gets its own folder. Inheriting the previous session's meant
  // one session started at ~ and every later one did too, so every project on
  // the machine was in scope for all of them.
  const dir = draft.dir ?? '';
  // An app owns its directory. Attaching a session to one is the normal case:
  // several sessions on one app, each free to run a different model.
  let appList = [];
  try { appList = (await api('/api/apps')).apps; } catch { /* apps are optional */ }
  openSheet(`<h2>New session</h2>
    <label>App</label>
    <select id="n-app">
      <option value="">— no app, just a folder —</option>
      ${appList.map((a) => `<option value="${esc(a.id)}"${draft.appId === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}
    </select>
    <label>Name</label><input id="n-name" placeholder="${esc(nextTabName(draft.appId))}" />
    <div id="n-computer-row" hidden><label>Computer</label><select id="n-computer"></select></div>
    <label>Model</label><select id="n-model">${modelOptions(state.default)}</select>
    <label>Mode</label>
    <select id="n-mode">
      <option value="agent">agent — tools, works in a project folder</option>
      <option value="chat">chat — plain Q&amp;A, no tools</option>
    </select>
    <label>Project directory — its own folder, created if new</label>
    <div class="row"><input id="n-dir" value="${esc(dir)}" placeholder="~/Projects/…" spellcheck="false" />
    <button class="ghost" id="n-browse" style="flex:0 0 92px">browse</button></div>
    <label>Extra instructions (optional)</label><textarea id="n-sys"></textarea>
    <div class="actions"><button class="ghost" id="n-cancel">cancel</button>
    <button class="primary" id="n-go">create</button></div>`);

  if (draft.name) $('n-name').value = draft.name;
  if (draft.system) $('n-sys').value = draft.system;
  if (draft.dir) $('n-dir').value = draft.dir;
  if (draft.model && state.models[draft.model]) $('n-model').value = draft.model;
  if (draft.mode) $('n-mode').value = draft.mode;

  const keep = () => {
    draft = {
      ownerNode: $('n-computer').value || undefined,
      appId: $('n-app').value || null,
      name: $('n-name').value, system: $('n-sys').value,
      dir: $('n-dir').value, model: $('n-model').value, mode: $('n-mode').value,
    };
  };

  // Suggest a folder from the name, and stop as soon as the user edits it.
  let dirTouched = Boolean(draft.dir);
  const slug = (t) => t.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const suggest = () => {
    if (dirTouched) return;
    const name = slug($('n-name').value) || 'session';
    $('n-dir').value = `${state.home}/Projects/${name}`;
  };
  $('n-name').addEventListener('input', suggest);
  $('n-dir').addEventListener('input', () => { dirTouched = true; });
  suggest();

  // The app's directory wins, and the field goes read-only so the two cannot
  // disagree about where the session is working.
  let modelRequest = 0;
  const loadComputerModels = async () => {
    const request = ++modelRequest;
    $('n-go').disabled = true;
    try {
      const inventory = await api(`/api/execution-models?app=${encodeURIComponent($('n-app').value)}&host=${encodeURIComponent($('n-computer').value)}`);
      if (request !== modelRequest || !$('n-computer')) return;
      $('n-model').innerHTML = Object.values(inventory.models).map(m => `<option value="${esc(m.alias)}">${esc(m.label || m.alias)}${m.hasKey ? '' : ' — no key'}</option>`).join('');
      $('n-model').value = inventory.models[draft.model] ? draft.model : inventory.default;
      $('n-go').disabled = false;
    } catch (e) { if (request === modelRequest) showBanner(e.message); }
  };
  $('n-computer').onchange = loadComputerModels;
  const applyApp = () => {
    $('n-name').placeholder = nextTabName($('n-app').value);
    const eligible = state.apps?.find(a => a.id === $('n-app').value)?.executionHosts || [state.machines?.leader];
    const hosts = (state.machines?.hosts || []).filter(h => eligible.includes(h.id));
    $('n-computer-row').hidden = hosts.length < 2;
    $('n-computer').innerHTML = hosts.map(h => `<option value="${esc(h.id)}">${h.number} · ${esc(h.name)}${h.active ? '' : ' · offline'}</option>`).join('');
    if (hosts.some(h => h.id === draft.ownerNode)) $('n-computer').value = draft.ownerNode;
    if (hosts.length) loadComputerModels();
    const app = appList.find((a) => a.id === $('n-app').value);
    if (app) {
      $('n-dir').value = app.dir;
      $('n-dir').disabled = true;
      dirTouched = true;
    } else {
      $('n-dir').disabled = false;
    }
  };
  $('n-app').addEventListener('change', applyApp);
  applyApp();

  $('n-cancel').onclick = () => { draft = {}; sessionsSheet(); };
  $('n-browse').onclick = () => {
    keep();
    browseSheet($('n-dir').value, (chosen) => { draft.dir = chosen; newSheet(); });
  };
  let submitting = false;
  const createButton = $('n-go');
  createButton.onclick = async () => {
    if (submitting || createButton.disabled) return;
    const chosen = $('n-dir').value.trim().replace(/\/+$/, '');
    if (!chosen && !$('n-app').value) return showBanner('give this session a folder of its own');
    if (chosen === state.home.replace(/\/+$/, '')) {
      return showBanner('that is your home folder — give the session its own directory, or everything on the machine is in scope');
    }
    submitting = true;
    createButton.disabled = true;
    try {
      const session = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          appId: $('n-app').value || null,
          ownerNode: $('n-computer').value || undefined,
          name: $('n-name').value.trim() || nextTabName($('n-app').value),
          model: $('n-model').value,
          mode: $('n-mode').value,
          projectDir: chosen,
          system: $('n-sys').value,
        }),
      });
      draft = {};
      state.sessions.unshift(session);
      await openSession(session.id);
    } catch (e) {
      showBanner(e.message, true);
      submitting = false;
      createButton.disabled = false;
    }
  };
}

async function browseSheet(start, pick, back = newSheet) {
  const load = async (p) => {
    let d;
    try {
      d = await api(`/api/dirs?path=${encodeURIComponent(p)}`);
    } catch (err) {
      openSheet(`<h2>Choose directory</h2><p class="dim">could not read that folder: ${esc(err.message)}</p>
        <div class="actions"><button class="ghost" id="b-home">go home</button></div>`);
      $('b-home').onclick = () => load(state.home);
      return;
    }
    openSheet(`<h2>Choose directory</h2><p class="dim">${esc(shortDir(d.path))}</p>
      ${d.note ? `<p class="dim warn-text">${esc(d.note)}</p>` : ''}
      ${d.parent ? `<div class="item" data-go="${esc(d.parent)}"><div class="grow"><div class="t">../</div></div></div>` : ''}
      ${d.dirs.map((x) => `<div class="item" data-go="${esc(x.path)}"><div class="grow"><div class="t">${esc(x.name)}/</div></div></div>`).join('')}
      <div class="actions"><button class="ghost" id="b-new">new folder</button>
      <button class="primary" id="b-use">use this one</button></div>
      <div class="actions"><button class="ghost" id="b-cancel">cancel</button></div>`);
    $('sheet').querySelectorAll('[data-go]').forEach((el) => { el.onclick = () => load(el.dataset.go); });
    $('b-cancel').onclick = back;
    $('b-use').onclick = () => pick(d.path);
    $('b-new').onclick = async () => {
      const name = prompt('New folder name');
      if (!name?.trim()) return;
      const made = await api('/api/dirs', {
        method: 'POST',
        body: JSON.stringify({ parent: d.path, name: name.trim() }),
      });
      load(made.path);
    };
  };
  load(start || state.home);
}

async function settingsSheet() {
  openSheet(`
    <h2>Distributed Orchestrator settings</h2>
    <div class="rowlinks">
      <button class="rowlink" id="h-github"><span>GitHub connection</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-network"><span>Phone access · Tailscale</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-machines"><span>Machines</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-models"><span>AI sources</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-voice"><span>Voice setup</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-notify"><span>Notifications</span><span class="chev">›</span></button>
    </div>
    <div class="actions"><button class="primary" id="s-close">done</button></div>`);

  $('h-github').onclick = githubSheet;
  $('h-machines').onclick = machinesSheet;
  $('h-network').onclick = networkSheet;
  $('h-models').onclick = modelsSheet;
  $('h-voice').onclick = () => window.voiceSetup();
  $('h-notify').onclick = notifySheet;

  $('s-close').onclick = closeSheet;
}

async function githubSheet() {
  openSheet(`<h2>GitHub connection</h2>
    <div class="item"><div class="grow"><div id="github-status" role="status">Checking connection…</div></div></div>
    <div id="github-code-panel" class="github-code-panel" hidden>
      <p class="dim">Enter this confirmation code on GitHub</p>
      <output id="github-code" class="github-code" aria-label="GitHub confirmation code"></output>
      <button class="ghost" id="github-copy">Copy code</button>
      <p class="dim">After approving, return here. We’ll connect automatically.</p>
    </div>
    <div id="github-actions" class="actions"></div>
    <p class="dim">Back up your projects to private GitHub repositories.</p>
    <details class="github-details"><summary>What gets shared</summary>
      <p class="dim">GitHub receives project files and commit history, not chat transcripts or saved integration credentials. The connection is shared with your paired hosts.</p>
      <p class="dim">Projects with automatic Git enabled are pushed after their next changed turn. New repositories are private. Manage visibility in Edit session → Git &amp; GitHub.</p>
    </details>
    ${backToSettings}`);
  const box = $('github-status');
  $('sub-back').onclick = settingsSheet;
  const present = () => $('github-status') === box;
  const post = (path) => api('/api/github/' + path, { method: 'POST', body: '{}' });
  const fail = (e) => { if (present()) box.textContent = e.message; };
  const poll = async () => {
    if (!present()) return;
    try {
      const result = await api('/api/github/login');
      if (!present()) return;
      if (result.state === 'ready') { await post('finish'); if (present()) await githubSheet(); return; }
      if (result.state === 'connected') { await githubSheet(); return; }
      if (result.state === 'failed' || result.state === 'idle') {
        box.textContent = result.error || 'No login in progress. Reopen GitHub connection to try again.';
        return;
      }
      box.textContent = result.code ? 'Waiting for approval' : 'Preparing GitHub login…';
      $('github-code-panel').hidden = !result.code;
      $('github-code').textContent = result.code || '';
      $('github-copy').onclick = async () => {
        const copied = await copyText(result.code);
        if (present()) $('github-copy').textContent = copied ? 'Copied' : 'Select the code to copy';
      };
      $('github-actions').innerHTML = result.code
        ? '<a class="primary" href="https://github.com/login/device" target="_blank" rel="noopener noreferrer">Continue on GitHub</a>' : '';
      setTimeout(poll, 2000);
    } catch (e) { fail(e); }
  };
  try {
    const status = await api('/api/github');
    if (!present()) return;
    box.textContent = status.authenticated
      ? `Connected as ${status.login}`
      : 'GitHub is not connected. Your work stays on your hosts.';
    if (status.authenticated) return;
    $('github-actions').innerHTML = `<button class="primary" id="github-connect">Connect GitHub</button>`;
    $('github-connect').onclick = async () => {
      $('github-connect').disabled = true;
      try {
        {
          const result = await post('login');
          if (result.state === 'connected') { if (present()) await githubSheet(); }
          else await poll();
        }
      } catch (e) { fail(e); if ($('github-connect')) $('github-connect').disabled = false; }
    };
    if (status.missingCli) box.textContent += ' Install GitHub CLI on the host first (cli.github.com).';
    const pending = await api('/api/github/login');
    if (present() && ['starting', 'waiting', 'ready'].includes(pending.state)) await poll();
  } catch (e) { fail(e); }
}

async function sessionSettingsSheet() {
  try { await refreshState(); } catch (e) { if (executionNode) return machinesSheet(); throw e; }
  const session = cur().session;
  openSheet(`
    ${session ? `<h2>Edit session</h2>
      <label>Name</label>
      <div class="row"><input id="s-name" value="${esc(session.name ?? '')}" spellcheck="false" />
      <button class="ghost" id="s-rename" style="flex:0 0 80px">rename</button></div>
      ${(state.apps?.find(a => a.id === session.appId)?.executionHosts?.length || 0) > 1 ? `
        <label>Computer</label>
        <div id="s-computers">${state.machines.hosts.filter(h => state.apps.find(a => a.id === session.appId).executionHosts.includes(h.id)).map(h => `
          <button class="rowlink" data-tab-computer="${esc(h.id)}" ${session.tabWorkspace || session.turnHost ? 'disabled' : ''}><span>${h.number} · ${esc(h.name)}</span><span class="dim">${h.id === session.ownerNode ? 'owns this tab' : h.active ? 'use computer' : 'offline'}</span></button>`).join('')}</div>
        <p class="dim">Each tab uses its computer’s models and files. To work on another computer after this tab has started, create a new tab there.</p>` : ''}
      <label>Model — tap to switch, history carries over</label>
      <div id="s-models">${Object.values(state.models).map((m) => `
        <div class="item${m.alias === session.model ? ' on' : ''}" data-switch="${esc(m.alias)}">
          <div class="grow"><div class="t">${esc(m.label ?? m.alias)}</div>
          <div class="s">${esc(m.provider)} · ${esc(m.model)}</div></div>
          ${m.alias === session.model
            ? '<span class="pill ready">in use</span>'
            : `<span class="pill ${m.hasKey ? '' : 'missing'}">${m.hasKey ? 'switch' : 'no key'}</span>`}
        </div>`).join('')}</div>
      <label>Mode</label>
      <div class="row">
        <button class="ghost${session.mode !== 'chat' ? ' on' : ''}" data-mode="agent">agent</button>
        <button class="ghost${session.mode === 'chat' ? ' on' : ''}" data-mode="chat">chat</button>
      </div>
      <p class="dim">chat sends no tools and no project rules — much less context, better for plain questions.</p>
      <label>Project folder${session.projectDirMissing ? ' — missing!' : ''}</label>
      <div class="row"><input id="s-dir" value="${esc(session.projectDir)}" spellcheck="false" />
      <button class="ghost" id="s-browse" style="flex:0 0 92px">browse</button></div>
      <div class="actions"><button class="ghost" id="s-dir-save">save folder</button></div>
      <label>Reference folders (read-only)</label>
      <textarea id="s-readable" spellcheck="false"
        placeholder="/Users/you/Projects/otherProject">${esc((session.readableDirs ?? []).join('\n'))}</textarea>
      <p class="dim">Let the agent’s file tools read reference material outside this project without granting write access. Enter one folder per line; leave empty if unneeded.</p>
      <div class="actions"><button class="ghost" id="s-readable-save">save folders</button></div>

      ${(() => {
        const m = state.models[session.model];
        if (!m?.softLimitTokens) return '';
        const on = Boolean(session.allowLongContext);
        return `<label>Context band</label>
          <div class="row">
            <button class="ghost${on ? '' : ' on'}" data-band="off">stay under ${compact(m.softLimitTokens)}</button>
            <button class="ghost${on ? ' on' : ''}" data-band="on">allow up to ${compact(m.contextTokens)}</button>
          </div>
          <p class="dim">${esc(m.label ?? m.alias)} reprices the whole request past
            ${compact(m.softLimitTokens)} input tokens — roughly double. Staying under trims old tool
            output to fit; allowing it keeps everything and pays the higher rate.</p>`;
      })()}` : ''}

    <div class="actions"><button class="ghost" id="session-git">Git &amp; GitHub</button><button class="primary" id="s-close">done</button></div>`);
  $('sheet').querySelectorAll('[data-tab-computer]').forEach(button => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        const updated = await api(`/api/sessions/${session.id}/machine`, { method: 'POST', body: JSON.stringify({ ownerNode: button.dataset.tabComputer }) });
        cur().session = updated;
        state.session = updated;
        await openSession(updated.id);
        await sessionSettingsSheet();
      } catch (e) { showBanner(e.message); button.disabled = false; }
    };
  });
  $('session-git').onclick = gitSheet;
  $('s-close').onclick = closeSheet;
  if ($('s-rename')) {
    const rename = async () => {
      const name = $('s-name').value.trim();
      if (!name || name === session.name) return;
      const updated = await api(`/api/sessions/${session.id}`, {
        method: 'PATCH', body: JSON.stringify({ name }),
      });
      const t = cur();
      t.session = updated;
      if (state.tab === 'chat') state.session = updated;
      paintHeader();
      await refreshState();          // the ☰ list shows the old name otherwise
      showBanner(`renamed to "${name}"`);
    };
    $('s-rename').onclick = rename;
    // Enter should work too; a phone keyboard offers "done", not a button.
    $('s-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); rename(); } });
  }
  if ($('s-readable-save')) {
    $('s-readable-save').onclick = async () => {
      const dirs = $('s-readable').value.split('\n').map((x) => x.trim()).filter(Boolean);
      const updated = await api(`/api/sessions/${session.id}`, {
        method: 'PATCH', body: JSON.stringify({ readableDirs: dirs }),
      });
      const t = cur();
      t.session = updated;
      if (state.tab === 'chat') state.session = updated;
      showBanner(dirs.length ? `${dirs.length} folder(s) readable` : 'no extra folders');
      sessionSettingsSheet();
    };
  }
  $('sheet').querySelectorAll('[data-band]').forEach((el) => {
    el.onclick = async () => {
      const t = cur();
      try {
        const updated = await api(`/api/sessions/${t.session.id}`, {
          method: 'PATCH', body: JSON.stringify({ allowLongContext: el.dataset.band === 'on' }),
        });
        t.session = updated;
        if (state.tab === 'chat') state.session = updated;
        sessionSettingsSheet();
      } catch (e) { showBanner(`couldn't change that: ${e.message}`, true); }
    };
  });
  $('sheet').querySelectorAll('[data-mode]').forEach((el) => {
    el.onclick = async () => {
      const t = cur();
      const want = el.dataset.mode;
      // Always send it — never trust local state to decide "already there", or a
      // stale copy could block the very switch the user is trying to make.
      // A silently-failed PATCH used to leave the toggle looking stuck — the
      // reported "switched to chat and couldn't switch back". Show what happened.
      el.textContent = '…';
      try {
        const updated = await api(`/api/sessions/${t.session.id}`, {
          method: 'PATCH', body: JSON.stringify({ mode: want }),
        });
        t.session = updated;
        if (state.tab === 'chat') state.session = updated;
        paintHeader();
        sessionSettingsSheet();
      } catch (e) {
        showBanner(`couldn't switch mode: ${e.message} — tap again`, true);
        sessionSettingsSheet();   // restore the buttons to their true state
      }
    };
  });
  $('sheet').querySelectorAll('[data-switch]').forEach((el) => {
    el.onclick = async () => {
      await setSessionModel(el.dataset.switch);
      sessionSettingsSheet();   // redraw so "in use" moves to the model just chosen
    };
  });
  if ($('s-browse')) {
    $('s-browse').onclick = () => browseSheet($('s-dir').value, async (chosen) => {
      await setProjectDir(chosen);
      sessionSettingsSheet();
    }, sessionSettingsSheet);
    $('s-dir-save').onclick = () => setProjectDir($('s-dir').value.trim()).then(sessionSettingsSheet);
  }
}

/**
 * Distributed Orchestrator-wide settings, one sheet each.
 *
 * These used to sit inline below the session settings, which made one very
 * long scroll — and put a second full list of model cards under the first,
 * which was mistaken for the switcher more than once. Each now has its own
 * sheet with a way back, so the main settings stay one screen.
 */
const backToSettings = '<div class="actions"><button class="ghost" id="sub-back">‹ settings</button></div>';

async function networkSheet() {
  openSheet(`<h2>Phone access</h2>
    <p class="dim">Install Tailscale on this host and your phone, then sign into the same network. The host must stay awake and running.</p>
    <p><a href="https://tailscale.com/download" target="_blank" rel="noopener">Get Tailscale</a></p>
    <p class="dim">Mac: use the installed Tailscale app. Linux or Windows WSL2: connect Tailscale inside the environment running this server.</p>
    <div id="network-status" role="status">Checking connection…</div>
    <div class="actions"><button class="ghost" id="network-check">check again</button><button class="primary" id="network-setup" disabled>set up phone access</button></div>
    <p class="dim">Setup publishes private HTTPS within your Tailscale network. Other Orchestrator hosts in Machines use the same address. Existing routes are preserved. If this server requires an access token, open its new address with that token on your phone.</p>${backToSettings}`);
  $('sub-back').onclick = settingsSheet;
  const box = $('network-status');
  const setup = $('network-setup');
  const check = $('network-check');
  const refresh = async (configure = false) => {
    setup.disabled = check.disabled = true;
    box.textContent = configure ? 'Setting up private HTTPS…' : 'Checking connection…';
    try {
      const n = await api(configure ? '/api/network/setup' : '/api/network', configure ? { method: 'POST', body: '{}' } : {});
      if ($('network-status') !== box) return;
      box.replaceChildren();
      const message = document.createElement('p'); message.textContent = n.message; box.append(message);
      for (const [label, url] of [['This host', n.localUrl], ['Phone / away from home', n.phoneUrl], ['Approve HTTPS in Tailscale', n.approvalUrl]]) {
        if (!url) continue;
        const row = document.createElement('p'); row.style.overflowWrap = 'anywhere';
        row.append(document.createTextNode(label + ': '));
        const link = document.createElement('a'); link.href = url; link.textContent = url; link.target = '_blank'; link.rel = 'noopener'; row.append(link); box.append(row);
      }
      setup.disabled = !n.connected || n.ready;
    } catch (e) { box.textContent = e.message; }
    finally { check.disabled = false; }
  };
  check.onclick = () => refresh();
  setup.onclick = () => refresh(true);
  await refresh();
}

// Errors may carry a Tailscale approval link; make it tappable without innerHTML.
function showLinked(box, text) {
  box.replaceChildren();
  for (const part of text.split(/(https:\/\/[^\s]+)/)) {
    if (!part.startsWith('https://')) { box.append(document.createTextNode(part)); continue; }
    const link = document.createElement('a'); link.href = part; link.textContent = part; link.target = '_blank'; link.rel = 'noopener';
    link.style.overflowWrap = 'anywhere'; box.append(link);
  }
}

function machineAddressLink(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '<div class="s">Address unavailable</div>';
    const address = esc(url.origin).replace(/"/g, '&quot;');
    return `<a class="machine-address" href="${address}" target="_blank" rel="noopener noreferrer">${address}</a>`;
  } catch { return '<div class="s">Address not configured</div>'; }
}

async function machinesSheet() {
  openSheet(`<h2>Machines</h2>
    <div id="cluster-summary" role="status">Checking machines…</div>
    <h3>Orchestrator hosts</h3><p class="dim">Preferred main is used at the next election; it does not interrupt a healthy main.</p><div id="machine-list"></div>
    <h3>Phones &amp; browser viewers</h3><div id="viewer-list"></div>
    <h3>Tailscale devices</h3><p class="dim">Network presence is separate from running this app. Devices are remembered after going offline; joining requires your approval.</p>
    <div id="tailnet-list">Checking Tailscale…</div>
    <h3>Add another host</h3>
    <ol class="dim join-steps">
      <li>On the <b>new</b> computer, tap <b>request to join</b> next to your existing main below. It sets up this computer’s private Tailscale HTTPS address automatically if needed.</li>
      <li>On the <b>existing main</b>, open Machines, tap <b>refresh</b>, then <b>Approve host</b>.</li>
    </ol>
    <p class="dim">Approved hosts receive shared sessions, project files, and API credentials; subscription logins stay on each computer.</p>
    <div id="discovered-hosts">Looking for Orchestrator hosts…</div>
    <p id="pairing-status" class="dim" role="status"></p>
    <div id="cluster-join">
      <label>Main host’s HTTPS address (if not listed)</label><input id="cluster-url" type="url" placeholder="https://laptop.your-tailnet.ts.net" />
      <div class="actions"><button class="ghost" id="cluster-connect">request to join</button><button class="ghost" id="cluster-cancel">cancel request</button></div>
    </div>
    <p id="machine-error" class="dim" role="status"></p>
    <div class="actions"><button class="ghost" id="machines-refresh">refresh</button></div>${backToSettings}`);
  $('sub-back').onclick = settingsSheet;
  $('machines-refresh').onclick = machinesSheet;
  const list = $('machine-list');
  const call = async (route, body) => {
    const response = await nativeFetch('/api/cluster/' + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  };
  const seen = (at) => at ? new Date(at).toLocaleString() : 'not yet observed';
  try {
    const data = await call('status');
    if ($('machine-list') !== list) return;
    $('cluster-summary').textContent = `${data.hosts.filter((n) => n.member).length} hosts · ${data.viewers.filter((v) => v.active).length} connected viewers · ${data.mode}`;
    if (data.mode === 'two-host availability') $('cluster-summary').append(document.createTextNode('. Both hosts may become main during a network split; divergent history is preserved for recovery.'));
    list.innerHTML = data.hosts.map((n) => `<div class="item machine-item"><div class="grow"><div class="t"><span class="computer-badge">🖥 ${n.number}</span> ${esc(n.name)}</div>
      <div class="s">${n.active ? 'active' : 'offline'} · ${n.id === data.leader ? 'main' : 'replica'}${n.id === data.preferred ? ' · preferred main' : ''}</div>
      <div class="s">${esc(n.platform === 'darwin' ? 'Mac' : n.platform === 'win32' ? 'Windows PC' : n.platform || 'Computer')}</div>
      ${machineAddressLink(n.url)}
      <div class="s">Last contact: ${esc(seen(n.lastSeen))}</div></div>
      ${n.member ? `<button class="ghost" data-machine-name="${esc(n.id)}">rename</button>` : ''}
      ${n.member && n.id !== data.preferred ? `<button class="ghost" data-prefer="${esc(n.id)}">prefer main</button>` : ''}</div>`).join('');
    list.querySelectorAll('[data-prefer]').forEach((button) => { button.onclick = async () => {
      try { await call('preferred', { id: button.dataset.prefer }); await machinesSheet(); }
      catch (e) { if ($('machine-error')) $('machine-error').textContent = e.message; }
    }; });
    list.querySelectorAll('[data-machine-name]').forEach((button) => { button.onclick = async () => {
      const host = data.hosts.find((n) => n.id === button.dataset.machineName);
      openSheet(`<h2>Rename computer ${host.number}</h2><label>Name</label><input id="machine-name-input" maxlength="100" /><div class="actions"><button class="ghost" id="machine-name-cancel">cancel</button><button class="primary" id="machine-name-save">save</button></div>`);
      $('machine-name-input').value = host.name;
      $('machine-name-cancel').onclick = machinesSheet;
      $('machine-name-save').onclick = async () => {
        try {
          await call('name', { id: host.id, name: $('machine-name-input').value });
          await refreshState();
          paintHeader();
          await machinesSheet();
        } catch (e) { showBanner(e.message); }
      };
    }; });
    $('viewer-list').innerHTML = data.viewers.map((v) => `<div class="item machine-item"><div class="grow"><div class="t">${esc(v.name)}</div><div class="s">${v.active ? 'connected' : 'disconnected'} · last activity ${esc(seen(v.lastSeen))}</div><div class="s">First seen ${esc(seen(v.firstSeen))}</div></div></div>`).join('') || '<p class="dim">No browser heartbeat received yet. This view updates when you refresh.</p>';
    $('cluster-join').hidden = data.hosts.filter((n) => n.member).length > 1;
    for (const issue of data.placementIssues || []) {
      const message = document.createElement('p');
      message.textContent = `${issue.project} on ${issue.host}: ${issue.error}`;
      $('cluster-summary').append(message);
    }
    if (data.conflicts) $('cluster-summary').append(document.createTextNode(` ${data.conflicts} divergent history branch(es) were preserved in the cluster recovery files.`));
    const action = async (route, body, button) => {
      button.disabled = true;
      try {
        await call(route, body);
        if ($('machine-list') === list) await machinesSheet();
      } catch (e) { if ($('machine-list') === list) showLinked($('machine-error'), e.message); }
      finally { button.disabled = false; }
    };
    $('cluster-connect').onclick = () => action('request-join', { url: $('cluster-url').value.trim() }, $('cluster-connect'));
    $('cluster-cancel').onclick = () => action('cancel-join', {}, $('cluster-cancel'));
    // Discovery can take a few seconds; the existing hosts stay usable meanwhile.
    call('discover').then(found => {
      if ($('machine-list') !== list) return;
      $('pairing-status').textContent = found.local.message || found.error;
      $('cluster-cancel').hidden = !found.local.pending;
      $('cluster-connect').disabled = found.local.joining;
      const peers = found.hosts.filter(n => !data.hosts.some(h => h.member && h.id === n.node));
      $('discovered-hosts').innerHTML = peers.map(n => {
        const approval = n.pending?.target === data.self && data.self === data.leader;
        const canRequest = data.mode === 'standalone' && n.main && !found.local.joining;
        return `<div class="item machine-item"><div class="grow"><div class="t">${esc(n.device || n.name)}</div><div class="s">${esc(n.url)}</div><div class="s">${n.joining ? 'joining' : approval ? 'requests access to this system' : 'Orchestrator detected'}</div></div>
          ${approval ? `<button class="primary" data-pair-approve="${esc(n.url)}">Approve host</button>` : canRequest ? `<button class="ghost" data-pair-request="${esc(n.url)}">request to join</button>` : ''}</div>`;
      }).join('') || '<p class="dim">No other hosts found yet. The main must be running and have Phone access set up (it does if you already use it from your phone). Refresh to check again, or enter its address below.</p>';
      $('discovered-hosts').querySelectorAll('[data-pair-approve]').forEach(button => {
        button.onclick = () => action('approve-host', { url: button.dataset.pairApprove }, button);
      });
      $('discovered-hosts').querySelectorAll('[data-pair-request]').forEach(button => {
        button.onclick = () => action('request-join', { url: button.dataset.pairRequest }, button);
      });
    }).catch(e => { if ($('machine-list') === list) $('pairing-status').textContent = e.message; });
    const inventory = await call('devices');
    if ($('machine-list') !== list) return;
    $('tailnet-list').innerHTML = inventory.devices.map((n) => `<div class="item machine-item"><div class="grow"><div class="t">${esc(n.name)}</div><div class="s">${n.active ? 'online on Tailscale' : 'offline on Tailscale'} · ${esc(n.platform || 'device')} · ${esc(seen(n.lastSeen))}</div></div></div>`).join('');
    if (inventory.error) $('tailnet-list').append(document.createTextNode(inventory.error));
  } catch (e) { if ($('machine-list') === list) $('machine-error').textContent = e.message; }
}

async function modelsSheet() {
  await refreshState();
  const rows = Object.values(state.models).map((m) => `
    <div class="item" data-model="${esc(m.alias)}">
      <div class="grow"><div class="t">${esc(m.label ?? m.alias)}</div>
      <div class="s">${esc(m.provider)} · ${esc(m.model)}</div></div>
      <span class="pill ${m.hasKey ? 'ready' : 'missing'}">${m.hasKey ? (m.keySource ?? 'ready') : 'no key'}</span>
    </div>`).join('');
  openSheet(`<h2>AI sources</h2>
    <p class="dim">Connect your own subscription login or API account. Each source adds a model to the session picker. Existing connections stay as they are when you add another.</p>
    ${rows}<div class="actions"><button class="primary" id="source-add">add AI source</button></div>${backToSettings}`);
  $('sub-back').onclick = settingsSheet;
  $('source-add').onclick = sourceSheet;
  $('sheet').querySelectorAll('[data-model]').forEach((el) => {
    el.onclick = () => modelSheet(el.dataset.model);
  });
}


function sourceSheet() {
  const choices = [
    ['Claude subscription (Claude Code)', 'claude-cli', '', ''],
    ['OpenAI subscription (Codex)', 'codex-cli', '', ''],
    ['OpenAI API', 'openai-responses', 'https://api.openai.com/v1', 'OPENAI_API_KEY'],
    ['Anthropic API', 'anthropic', '', 'ANTHROPIC_API_KEY'],
    ['Kimi / Moonshot API', 'openai', 'https://api.moonshot.ai/v1', 'MOONSHOT_API_KEY'],
    ['Grok / xAI API', 'openai', 'https://api.x.ai/v1', 'XAI_API_KEY'],
    ['Custom / local OpenAI-compatible API', 'openai', '', 'HARNESS_CUSTOM_API_KEY'],
  ];
  openSheet(`<h2>Add AI source</h2>
    <label>Connection</label><select id="source-kind">${choices.map((c, i) => `<option value="${i}">${c[0]}</option>`).join('')}</select>
    <p class="dim" id="source-help"></p>
    <label>Name in Distributed Orchestrator</label><input id="source-name" />
    <label>Model ID</label><input id="source-model" spellcheck="false" placeholder="Exact model ID from your provider" />
    <div id="source-api">
      <label>API endpoint</label><input id="source-url" type="url" spellcheck="false" placeholder="https://your-provider.example/v1" />
      <div id="source-auth"><label>Endpoint authentication</label><select id="source-auth-mode"><option value="key">API key</option><option value="none">No key (my private model server)</option></select></div>
      <label>API key</label><input id="source-key" type="password" autocomplete="off" />
      <p class="dim">API billing is separate from chat subscriptions. Local servers may not need a key. Keys are saved on the Distributed Orchestrator server.</p>
    </div>
    <p class="dim" id="source-error" role="status"></p>
    <div class="actions"><button class="ghost" id="source-back">back</button><button class="primary" id="source-save">add source</button></div>`);
  const change = () => {
    const [label, provider, base] = choices[$('source-kind').value];
    const subscription = provider.endsWith('-cli');
    $('source-name').value = label;
    $('source-url').value = base;
    $('source-api').hidden = subscription;
    $('source-auth').hidden = $('source-kind').value !== '6';
    $('source-help').textContent = subscription
      ? `Install ${provider === 'claude-cli' ? 'Claude Code and run claude' : 'Codex and run codex login'} on the computer hosting Distributed Orchestrator, then sign in with your own account. Distributed Orchestrator uses that computer’s CLI login. Adding this entry does not verify the login.`
      : 'Enter the model ID available in your provider account. Custom endpoints must support OpenAI chat completions; agent sessions also require tool calling.';
  };
  $('source-kind').onchange = change;
  change();
  $('source-back').onclick = modelsSheet;
  $('source-save').onclick = async () => {
    const [, provider, , apiKeyEnv] = choices[$('source-kind').value];
    $('source-save').disabled = true;
    try {
      await api('/api/models/add', { method: 'POST', body: JSON.stringify({
        apiKeyOptional: $('source-kind').value === '6' && $('source-auth-mode').value === 'none',
        label: $('source-name').value, model: $('source-model').value, provider, apiKeyEnv,
        baseUrl: provider.endsWith('-cli') ? '' : $('source-url').value.trim(),
        apiKey: provider.endsWith('-cli') ? '' : $('source-key').value.trim(),
      }) });
      await modelsSheet();
      showBanner('Source added. Select its model in session settings to use it.');
    } catch (e) {
      if ($('source-error')) $('source-error').textContent = e.message;
    } finally {
      if ($('source-save')) $('source-save').disabled = false;
    }
  };
}

function notifySheet() {
  openSheet(`<h2>Notifications</h2>
    <p class="dim">Choose which ways the harness can reach you. Email and Text can each be enabled independently.</p>
    <div class="rowlinks">
      <button class="rowlink" id="h-email"><span>Email</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-text"><span>Text</span><span class="chev">›</span></button>
    </div>${backToSettings}`);
  $('sub-back').onclick = settingsSheet;
  $('h-email').onclick = emailSheet;
  $('h-text').onclick = textSheet;
}

const backToNotifications = '<div class="actions"><button class="ghost" id="sub-back">‹ notifications</button></div>';

function textSheet() {
  openSheet(`<h2>Text</h2>
    <p class="dim">When a turn finishes, and when one stalls.</p>
    <div id="s-notify"><p class="dim">loading…</p></div>
    <p id="notify-status" class="dim" role="status" aria-live="polite"></p>${backToNotifications}`);
  $('sub-back').onclick = notifySheet;
  paintNotify();
}

function emailSheet() {
  openSheet(`<h2>Email</h2>
    <p class="dim">Receive email when a turn stalls or a session sends you an update.</p>
    <div id="s-email"><p class="dim">loading…</p></div>${backToNotifications}`);
  $('sub-back').onclick = notifySheet;
  paintEmail();
}

/**
 * Switch the open session's model.
 *
 * Both `state.session` and the tab's own copy have to be replaced: they started
 * as the same object, so assigning only one leaves the transcript rendering
 * against a stale session that still claims the old model.
 */
async function setSessionModel(alias) {
  const t = cur();
  if (!t.session || alias === t.session.model) return;

  const updated = await api(`/api/sessions/${t.session.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ model: alias }),
  });
  t.session = updated;
  if (state.tab === 'chat') state.session = updated;
  drawTranscript();
  paintHeader();
}

/** Outbound email — one harness-wide setting, used by every session's send_email tool. */
async function paintEmail() {
  const box = $('s-email');
  if (!box) return;
  let e;
  try { e = await api('/api/email'); } catch (err) { box.innerHTML = `<p class="dim">${esc(err.message)}</p>`; return; }

  box.innerHTML = `
    <label>Email notifications</label>
    <div class="row">
      <button class="ghost${e.enabled ? '' : ' on'}" data-email="off" aria-pressed="${!e.enabled}">off</button>
      <button class="ghost${e.enabled ? ' on' : ''}" data-email="on" aria-pressed="${Boolean(e.enabled)}">on</button>
    </div>
    <label>Send to</label>
    <input id="em-to" value="${esc(e.to ?? '')}" placeholder="you@example.com" inputmode="email" spellcheck="false" />
    <label>Resend API key ${e.hasKey ? '<span class="pill ready">saved</span>' : '<span class="pill missing">none</span>'}</label>
    <input id="em-key" value="" placeholder="${e.hasKey ? 'saved — type to replace' : 're_...'}" spellcheck="false" />
    <div class="actions">
      <button class="ghost" id="em-save">save</button>
      <button class="ghost" id="em-test"${e.enabled && e.hasKey && e.to ? '' : ' disabled'}>send test</button>
    </div>
    <p class="dim" id="em-msg"></p>`;

  box.querySelectorAll('[data-email]').forEach((el) => {
    el.onclick = async () => {
      try {
        await api('/api/email', { method: 'POST', body: JSON.stringify({ enabled: el.dataset.email === 'on' }) });
        await paintEmail();
      } catch (err) { $('em-msg').textContent = err.message; }
    };
  });
  $('em-save').onclick = async () => {
    const body = { to: $('em-to').value.trim() };
    // An empty box means "leave it alone", not "erase the key".
    const key = $('em-key').value.trim();
    if (key) body.apiKey = key;
    $('em-msg').textContent = 'saving…';
    try { await api('/api/email', { method: 'POST', body: JSON.stringify(body) }); paintEmail(); }
    catch (err) { $('em-msg').textContent = err.message; }
  };
  $('em-test').onclick = async () => {
    $('em-msg').textContent = 'sending…';
    try {
      const r = await api('/api/email/test', { method: 'POST' });
      $('em-msg').textContent = `sent to ${r.to}`;
    } catch (err) { $('em-msg').textContent = err.message; }
  };
}

/** Notification settings — global, not per session. */
async function paintNotify() {
  const box = $('s-notify');
  if (!box) return;
  const status = $('notify-status');
  const feedback = (message) => { if (status) status.textContent = message; };
  let n;
  try { n = await api('/api/notify'); } catch (e) { box.innerHTML = `<p class="dim">${esc(e.message)}</p>`; return; }

  const kinds = [
    ['sms', 'text (SMS)'],
    ['webhook', 'push (ntfy)'],
    ['messages', 'iMessage'],
    ['command', 'shell command'],
  ];
  box.innerHTML = `
    ${n.kind === 'sms' && (!n.gmailUser || !n.hasGmailPass) ? '<p class="dim">SMS setup is incomplete. Add a Gmail address and app password below, or turn notifications off.</p>' : ''}
    <div class="row">
      <button class="ghost${n.enabled ? '' : ' on'}" data-notify="off">off</button>
      <button class="ghost${n.enabled ? ' on' : ''}" data-notify="on">on</button>
    </div>
    <div class="row" style="margin-top:8px">
      ${kinds.map(([k, label]) =>
    `<button class="ghost${n.kind === k ? ' on' : ''}" data-nkind="${k}">${label}</button>`).join('')}
    </div>
    ${n.kind === 'sms'
      ? `<label>Phone number</label>
         <input id="n-to" value="${esc(n.to ?? '')}" placeholder="8045551234" inputmode="tel" />
         <label>Gmail address it sends from</label>
         <input id="n-guser" value="${esc(n.gmailUser ?? '')}" placeholder="you@gmail.com" inputmode="email" spellcheck="false" />
         <label>Gmail app password ${n.hasGmailPass ? '<span class="pill ready">saved</span>' : '<span class="pill missing">none</span>'}</label>
         <input id="n-gpass" type="password" autocomplete="new-password" value="" placeholder="${n.hasGmailPass ? 'saved — type to replace' : 'abcd efgh ijkl mnop'}" spellcheck="false" />
         <p class="dim">Not your Google password — make one at myaccount.google.com → Security → App passwords. It only works if 2-step verification is on.</p>
         <label>Carrier</label>
         <select id="n-carrier">
           <option value="">try every carrier (first test)</option>
           ${['verizon', 'att', 'tmobile', 'googlefi', 'sprint', 'uscellular', 'cricket', 'boost', 'mint', 'visible']
    .map((c) => `<option value="${c}"${n.carrier === c ? ' selected' : ''}>${c}</option>`).join('')}
         </select>
         <p class="dim">This sends mail to your carrier's SMS gateway, so it arrives as a normal text. Nothing on the Mac is involved — it works with the lid shut.</p>`
      : n.kind === 'messages'
        ? `<label>Phone number</label><input id="n-to" value="${esc(n.to ?? '')}" placeholder="+18045551234" inputmode="tel" />
           <p class="dim">Sends through the Messages app, which needs the Mac's screen awake — it cannot work with the lid shut.</p>`
      : n.kind === 'webhook'
        ? `<label>Webhook URL</label><input id="n-url" value="${esc(n.url ?? '')}" placeholder="https://ntfy.sh/your-topic" spellcheck="false" inputmode="url" />`
        : `<label>Command (<span class="mono">{{message}}</span> is substituted)</label>
           <input id="n-cmd" value="${esc(n.command ?? '')}" spellcheck="false" />`}
    <label>Only for turns longer than</label>
    <div class="row">
      ${[0, 60, 300].map((sec) =>
    `<button class="ghost${(n.minSeconds ?? 60) === sec ? ' on' : ''}" data-nmin="${sec}">${sec === 0 ? 'always' : `${sec / 60} min`}</button>`).join('')}
    </div>
    <div class="actions">
      <button class="ghost" id="n-save">save</button>
      <button class="ghost" id="n-test">send a test</button>
    </div>`;

  const patch = async (body) => { await api('/api/notify', { method: 'POST', body: JSON.stringify(body) }); await paintNotify(); };
  box.querySelectorAll('[data-notify]').forEach((el) => {
    el.onclick = async () => {
      const enabled = el.dataset.notify === 'on';
      const body = enabled ? { ...fields(), enabled } : { enabled };
      el.disabled = true;
      feedback(enabled ? 'Saving and enabling…' : 'Turning off…');
      try {
        if (enabled) await saveGmail();
        await patch(body);
        feedback(enabled ? 'Text notifications enabled.' : 'Text notifications off.');
      } catch (e) {
        feedback(`Could not ${enabled ? 'enable' : 'disable'}: ${e.message}`);
      } finally {
        el.disabled = false;
      }
    };
  });
  box.querySelectorAll('[data-nkind]').forEach((el) => {
    el.onclick = () => patch({ kind: el.dataset.nkind });
  });
  box.querySelectorAll('[data-nmin]').forEach((el) => {
    el.onclick = () => patch({ minSeconds: Number(el.dataset.nmin) });
  });

  const fields = () => ({
    ...($('n-to') ? { to: $('n-to').value.trim() } : {}),
    ...($('n-url') ? { url: $('n-url').value.trim() } : {}),
    ...($('n-cmd') ? { command: $('n-cmd').value.trim() } : {}),
  });

  // The Gmail credential belongs with the other secrets, not in notify.json,
  // so it is saved through the email settings instead.
  const saveGmail = async () => {
    if (!$('n-guser')) return;
    const body = { gmailUser: $('n-guser').value.trim(), carrier: $('n-carrier').value };
    // An empty box means "leave it alone", never "erase the password".
    const pass = $('n-gpass').value.trim();
    if (pass) body.gmailPass = pass;
    await api('/api/email', { method: 'POST', body: JSON.stringify(body) });
  };
  $('n-save').onclick = async () => {
    feedback('saving…');
    try {
      await saveGmail();
      await patch(fields());
      feedback('Notification settings saved.');
    } catch (e) {
      feedback(`Could not save: ${e.message}`);
    }
  };
  $('n-test').onclick = async () => {
    const btn = $('n-test');
    btn.textContent = 'sending…';
    btn.disabled = true;
    feedback('Sending test…');
    try {
      await saveGmail();
      await api('/api/notify', { method: 'POST', body: JSON.stringify(fields()) });
      const r = await api('/api/notify/test', { method: 'POST', body: JSON.stringify({}) });
      feedback(r.ok ? `sent (${r.via})` : `failed: ${r.reason}`);
    } catch (e) {
      // A thrown request used to leave the button reading "sending…" for good,
      // which is indistinguishable from the thing still being in flight.
      feedback(`test failed: ${e.message}`);
    } finally {
      btn.disabled = false;
      paintNotify();
    }
  };
}

/**
 * Git panel for a session. Shows the repo as it really is, rather than assuming
 * — a missing remote is the usual reason a push silently does nothing.
 */
function gitSheet() {
  const session = cur().session;
  openSheet(`<h2>Git &amp; GitHub</h2>
    <p class="dim">${session ? `Settings for ${esc(session.name)}. Git saves changes locally; GitHub stores a remote copy. GitHub access uses the hosting computer’s gh login.` : 'Open a session to configure its repository and automatic commits.'}</p>
    <div id="s-git"></div><div class="actions"><button class="ghost" id="sub-back">‹ edit session</button></div>`);
  $('sub-back').onclick = sessionSettingsSheet;
  if (session) paintGit(session);
}

async function paintGit(session) {
  const box = $('s-git');
  if (!box) return;
  let g;
  try {
    g = await api(`/api/git?session=${encodeURIComponent(session.id)}`);
  } catch (e) {
    box.innerHTML = `<p class="dim warn-text">${esc(e.message)}</p>`;
    return;
  }

  if (!g.repo) {
    box.innerHTML = `<p class="dim">${esc(shortDir(session.projectDir))} is not a git repository.</p>
      <label>Connect a remote (creates the repo)</label>
      <div class="row"><input id="g-remote" placeholder="git@github.com:you/repo.git" spellcheck="false" />
      <button class="ghost" id="g-connect" style="flex:0 0 80px">connect</button></div>`;
  } else {
    box.innerHTML = `
      <p class="dim">branch <span class="mono">${esc(g.branch ?? '?')}</span>
        · ${g.changed} uncommitted
        · ${g.remote ? `remote <span class="mono">${esc(g.remote)}</span>` : '<span class="warn-text">no remote</span>'}</p>
      ${g.lastCommit ? `<p class="dim">last: <span class="mono">${esc(g.lastCommit)}</span></p>` : '<p class="dim">no commits yet</p>'}
      ${g.remote ? '' : `<label>Add a remote</label>
        <div class="row"><input id="g-remote" placeholder="git@github.com:you/repo.git" spellcheck="false" />
        <button class="ghost" id="g-connect" style="flex:0 0 80px">connect</button></div>`}
      <div id="g-vis"></div>
      <div class="actions"><button class="ghost" id="g-now">check &amp; integrate now</button></div>`;
  }

  if (g.isolated) box.insertAdjacentHTML('afterbegin', '<p class="dim">This tab has its own working copy. Changes reach the project only after merging and passing integration checks.</p>');
  box.insertAdjacentHTML('afterbegin', `<div class="row">
    <button class="ghost${g.enabled ? '' : ' on'}" data-git="off">automatic commits off</button>
    <button class="ghost${g.enabled ? ' on' : ''}" data-git="on">check &amp; integrate after each turn</button>
  </div>`);

  box.querySelectorAll('[data-git]').forEach((el) => {
    el.onclick = async () => {
      const updated = await api(`/api/sessions/${session.id}`, {
        method: 'PATCH', body: JSON.stringify({ gitPush: el.dataset.git === 'on' }),
      });
      const t = cur();
      t.session = updated;
      if (state.tab === 'chat') state.session = updated;
      paintGit(updated);
    };
  });
  if ($('g-connect')) {
    $('g-connect').onclick = async () => {
      const remote = $('g-remote').value.trim();
      if (!remote) return;
      const r = await api('/api/git/connect', {
        method: 'POST', body: JSON.stringify({ session: session.id, remote }),
      });
      if (!r.ok) showBanner(r.error);
      paintGit(session);
    };
  }
  if ($('g-vis')) {
    api('/api/git/visibility', { method: 'POST', body: JSON.stringify({ session: session.id }) })
      .then((v) => {
        const box = $('g-vis');
        if (!box) return;
        if (!v.ok) { box.innerHTML = `<p class="dim">${esc(v.reason)}</p>`; return; }
        const pub = v.visibility === 'public';
        box.innerHTML = `<p class="dim"><span class="mono">${esc(v.repo)}</span> is
            <strong class="${pub ? 'warn-text' : ''}">${esc(v.visibility)}</strong></p>
          <div class="row">
            <button class="ghost${pub ? '' : ' on'}" data-vis="private">private</button>
            <button class="ghost${pub ? ' on' : ''}" data-vis="public">public</button>
          </div>`;
        box.querySelectorAll('[data-vis]').forEach((el) => {
          el.onclick = async () => {
            const want = el.dataset.vis;
            if (want === v.visibility) return;
            if (want === 'public'
              && !confirm(`Make ${v.repo} public? Anyone will be able to read it and its full history.`)) return;
            const r = await api('/api/git/visibility', {
              method: 'POST', body: JSON.stringify({ session: session.id, visibility: want }),
            });
            showBanner(r.ok ? `${v.repo} is now ${r.visibility}` : `could not change: ${r.reason}`);
            paintGit(session);
          };
        });
      })
      .catch(() => {});
  }
  if ($('g-now')) {
    $('g-now').onclick = async () => {
      const button = $('g-now');
      button.textContent = 'checking…';
      button.disabled = true;
      try {
        const r = await api('/api/git/push', { method: 'POST', body: JSON.stringify({ session: session.id }) });
        showBanner(r.skipped === 'no changes' ? 'nothing to integrate'
          : !r.ok ? `git: ${r.error}`
            : r.pushed ? `integrated and pushed ${r.files.length} files · ${r.sha}`
              : `integrated ${r.sha} — not pushed: ${r.reason}`);
      } catch (e) { showBanner(e.message, true); }
      finally { await paintGit(session); }
    };
  }
}

/** Repoint a session at another folder, creating it if it isn't there. */
async function setProjectDir(dir) {
  if (!dir) return;
  state.session = await api(`/api/sessions/${state.session.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ projectDir: dir }),
  });
  state.session = await api(`/api/sessions/${state.session.id}`);
  paintHeader();
}

function modelSheet(alias) {
  const m = state.models[alias];
  if (['claude-cli', 'codex-cli'].includes(m.provider)) {
    openSheet(`<h2>${esc(m.label ?? alias)}</h2>
      <p class="dim">Uses the ${m.provider === 'claude-cli' ? 'Claude Code' : 'Codex'} login on the computer hosting Distributed Orchestrator. No API key is needed here. Sign in on that computer before using this source.</p>
      <label>Model ID</label><input id="subscription-model" spellcheck="false" />
      <p id="subscription-error" class="dim" role="status"></p>
      <div class="actions"><button class="ghost" id="subscription-back">back</button><button class="primary" id="subscription-save">save</button></div>`);
    $('subscription-model').value = m.model ?? '';
    $('subscription-back').onclick = modelsSheet;
    $('subscription-save').onclick = async () => {
      try {
        const model = $('subscription-model').value.trim();
        if (!model) throw new Error('Enter a model ID.');
        await api('/api/models/patch', { method: 'POST', body: JSON.stringify({ alias, patch: { model } }) });
        await modelsSheet();
      } catch (e) {
        if ($('subscription-error')) $('subscription-error').textContent = e.message;
      }
    };
    return;
  }

  openSheet(`<h2>${esc(m.label ?? alias)}</h2>
    <p class="dim">${esc(m.provider)} · key falls back to $${esc(m.keyEnv || 'none')}</p>
    <label>API key ${m.keySource === 'stored' ? '(a key is already saved)' : ''}</label>
    <input id="m-key" type="password" placeholder="paste key — leave blank to keep" autocomplete="off" />
    <label>Model id</label><input id="m-model" value="${esc(m.model ?? '')}" spellcheck="false" />
    <label>Base URL ${m.provider === 'anthropic' ? '(leave blank for Anthropic default)' : ''}</label>
    <input id="m-base" value="${esc(m.baseUrl ?? '')}" placeholder="https://…/v1" spellcheck="false" inputmode="url" />
    <div class="actions"><button class="ghost" id="m-discover">what does it serve?</button></div>
    <div id="m-list"></div>
    <div class="actions"><button class="ghost" id="m-cancel">back</button>
    <button class="primary" id="m-save">save</button></div>`);

  $('m-discover').onclick = async () => {
    $('m-list').innerHTML = '<p class="dim">asking the endpoint…</p>';
    // Save whatever is typed first, so it queries the endpoint and key on screen.
    const typed = $('m-key').value.trim();
    if (typed) await api('/api/models/key', { method: 'POST', body: JSON.stringify({ alias, apiKey: typed }) });
    await api('/api/models/patch', {
      method: 'POST',
      body: JSON.stringify({ alias, patch: { baseUrl: $('m-base').value.trim() } }),
    });

    const r = await api('/api/models/discover', { method: 'POST', body: JSON.stringify({ alias }) });
    if (!r.ok) {
      $('m-list').innerHTML = `<p class="dim warn-text">${esc(r.error)}</p>`;
      return;
    }
    $('m-list').innerHTML = `<p class="dim">${r.count} models available — tap one</p>`
      + r.models.map((id) => `<div class="item" data-pick="${esc(id)}"><div class="grow">
          <div class="t">${esc(id)}</div></div></div>`).join('');
    $('m-list').querySelectorAll('[data-pick]').forEach((el) => {
      el.onclick = () => { $('m-model').value = el.dataset.pick; };
    });
  };

  $('m-cancel').onclick = modelsSheet;
  $('m-save').onclick = async () => {
    const key = $('m-key').value.trim();
    if (key) await api('/api/models/key', { method: 'POST', body: JSON.stringify({ alias, apiKey: key }) });
    await api('/api/models/patch', {
      method: 'POST',
      body: JSON.stringify({
        alias,
        patch: { model: $('m-model').value.trim(), baseUrl: $('m-base').value.trim() },
      }),
    });
    modelsSheet();
  };
}

// ------------------------------------------------------------------- wire

// -------------------------------------------------------- background jobs

let jobsTimer = null;

/** Tail a log, refreshing on a timer, pinned to the newest line. */
async function watchLog(file) {
  const name = file.split('/').pop();
  const load = async () => {
    let text;
    try {
      text = await (await fetch(`/api/file?path=${encodeURIComponent(file)}&tail=1`)).text();
    } catch (e) {
      text = `could not read: ${e.message}`;
    }
    const pre = $('log-body');
    if (!pre) return;
    pre.textContent = text;
    pre.scrollTop = pre.scrollHeight;   // newest output is what matters
  };

  openSheet(`<h2>${esc(name)}</h2>
    <pre id="log-body" class="file-body">loading…</pre>
    <div class="actions">
      <button class="ghost" id="l-auto">auto-refresh</button>
      <button class="primary" id="l-close">done</button>
    </div>`);
  await load();

  $('l-auto').onclick = () => {
    if (jobsTimer) {
      clearInterval(jobsTimer);
      jobsTimer = null;
      $('l-auto').textContent = 'auto-refresh';
    } else {
      jobsTimer = setInterval(load, 3000);
      $('l-auto').textContent = 'stop auto-refresh';
    }
  };
  const done = () => { clearInterval(jobsTimer); jobsTimer = null; };
  $('l-close').onclick = () => { done(); closeSheet(); };
}

// ---------------------------------------------------------------- usage

const WINDOW_LABEL = {
  five_hour: 'last 5 hours', seven_day: 'last 7 days', month: 'last 30 days', all: 'all time',
};

const num = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const dur = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const untilReset = (at) => {
  if (!at) return '';
  const mins = Math.round((at - Date.now()) / 60000);
  if (mins <= 0) return 'resetting';
  return mins < 60 ? `resets in ${mins}m` : `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
};

function bar(pct, tone = '') {
  const clamped = Math.max(0, Math.min(1, pct));
  return `<div class="bar"><div class="bar-fill ${tone}" style="width:${(clamped * 100).toFixed(1)}%"></div></div>`;
}

let usageWindow = 'seven_day';


/**
 * Apps: the durable things. A session comes and goes; an app has a directory, a
 * repository, a port and two addresses, and is still here after a reboot.
 *
 * Both addresses are always shown together. The harness's tailscaled runs with
 * userspace networking, so the laptop cannot resolve its own .ts.net name —
 * showing only the tailnet link leaves you unable to open your own app on the
 * machine running it.
 */
// Which apps are expanded to show their sessions. Survives re-renders.
const expandedApps = new Set();

/**
 * One home for everything: apps at the top level, each expandable to the
 * sessions working on it. There is no separate sessions list — a session is
 * reached by opening its app. Sessions not tied to an app are grouped at the end.
 */
let lastAppsData = null;   // cached so expand/collapse re-renders without refetching

async function appsSheet() {
  if (sheetView !== 'apps') openProjectGroups.delete('recent');
  // Draw first, fetch second. This used to wait on /api/apps - which shells out
  // to lsof and tailscale - and then on /api/state, two round trips in series,
  // before a single pixel appeared, so tapping the sidebar felt dead for about
  // a second. The last known list goes up immediately and the fresh one folds
  // in when it lands; only the very first open of the session has nothing to
  // show. The two requests now go out together rather than one after the other.
  if (lastAppsData) renderAppsSheet(lastAppsData);
  else openSheet('<h2>Apps &amp; Chats</h2><p class="dim">loading…</p>', 'apps');

  let d;
  try { [d] = await Promise.all([api('/api/apps'), refreshState()]); }
  catch (e) {
    if (sheetView !== 'apps') return;
    if (lastAppsData) return showBanner(e.message);   // stale but usable beats blank
    return openSheet(`<h2>Apps</h2><p class="dim">${esc(e.message)}</p>`, 'apps');
  }
  lastAppsData = d;
  if (sheetView === 'apps') renderAppsSheet(d);
  return undefined;
}

/**
 * Draw the apps-and-sessions sheet from already-fetched data.
 *
 * Toggling an app's expander used to call appsSheet(), which re-hit /api/apps —
 * and that endpoint probes every app over HTTP, reads the Tailscale table and
 * asks gh for visibility, so a tap felt sluggish. Expansion is a pure view
 * change, so it re-renders from the cached data instead.
 */
// Keep the built-in project first, then runnable apps, then workspaces.
function orderProjects(apps) {
  const rank = (app) => app.builtin ? 0 : app.start?.trim() || app.running ? 1 : 2;
  return [...apps].sort((a, b) => rank(a) - rank(b));
}

// Runtime history keeps an app classified as an app if its command is cleared.
function projectGroups(apps) {
  const visible = [], stopped = [], chats = [];
  for (const app of apps) {
    if (app.builtin || app.running) visible.push(app);
    else if (app.hasBeenApp || app.start?.trim() || app.lastStartedAt) stopped.push(app);
    else chats.push(app);
  }
  return { visible: orderProjects(visible), stopped, chats };
}
const openProjectGroups = new Set();

let peerCatalog = null;
async function showPeerSessions() {
  const box = $('peer-sessions');
  if (!box) return;
  peerCatalog ??= nativeFetch('/api/nodes').then(async (r) => r.ok ? r.json() : []).finally(() => {
    setTimeout(() => { peerCatalog = null; }, 5000);
  });
  try {
    const nodes = await peerCatalog;
    if ($('peer-sessions') !== box) return;
    box.innerHTML = nodes.filter((n) => n.id !== executionNode).map((n) =>
      `<h3>${esc(n.name)} · ${n.online ? 'online' : 'offline'}</h3>` + (n.online
        ? (n.sessions ?? []).map((s) => `<button class="rowlink machine-choice" data-peer="${esc(n.id)}" data-session="${esc(s.id)}"><span>${esc(s.name)}</span><span class="chev">›</span></button>`).join('')
        : '<p class="dim">This machine’s work is unavailable until it reconnects.</p>')).join('');
    box.querySelectorAll('[data-peer]').forEach((button) => { button.onclick = () => {
      location.href = `/?node=${encodeURIComponent(button.dataset.peer)}&session=${encodeURIComponent(button.dataset.session)}`;
    }; });
  } catch { if ($('peer-sessions') === box) box.textContent = 'Could not load connected machines.'; }
}

async function restartOrchestrator(button) {
  button.disabled = true;
  closeSheet(); // Feedback must be visible, including a refused restart.
  showBanner('Restarting paired computers one at a time, then this computer…');
  try {
    const expected = await api('/api/harness/restart', { method: 'POST' });
    if (!expected.restartId) throw new Error('The old server accepted the restart but cannot verify it. Wait a few seconds, then refresh to load the updated restart control.');
    showBanner('Restarting — waiting for the replacement server…');
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 700));
      try {
        const current = await api('/api/harness/status', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
        if (current.restartId === expected.restartId && current.instanceId !== expected.instanceId && current.node === expected.node) {
          location.reload();
          return;
        }
      } catch { /* The listener is unavailable during a normal restart. */ }
    }
    throw new Error('Restart could not be verified. The old server may still be running, or its replacement failed. Check the server log on this host.');
  } catch (error) { showBanner(error.message, true); }
  finally { button.disabled = false; }
}

function renderAppsSheet(d) {
  // Redrawing throws the scroll position away, which is wrong both for an
  // expander tap and for the refresh that lands a moment after the sheet opens.
  const scroll = sheetView === 'apps' ? $('sheet').scrollTop : 0;
  const sessionsFor = (id) => state.sessions.filter((x) => x.appId === id);
  const known = new Set(d.apps.map((a) => a.id));
  const loose = state.sessions.filter((x) => !x.appId || !known.has(x.appId));

  const sessionRow = (sn) => {
    const app = d.apps.find((a) => a.id === sn.appId);
    const label = app ? `${app.name} · ${sn.name}` : sn.name;
    return `
    <div class="item sub-session${sn.id === state.session?.id ? ' on' : ''}" data-open="${esc(sn.id)}">
      <div class="grow"><div class="t">${esc(label)} ${sessionStatus(sn)}</div>
        <div class="s">${esc(sn.model)} · ${sn.turns} turns</div>
        <div class="s">Last activity: ${esc(clock(sn.updatedAt ?? sn.createdAt) || 'unknown')}</div></div>
      <button class="x" data-rename="${esc(sn.id)}" title="Edit session">✎</button>
      <button class="x" data-del="${esc(sn.id)}" title="Delete">×</button>
    </div>`;
  };

  const appCard = (a) => {
    const launchable = Boolean(a.start?.trim());
    const mine = sessionsFor(a.id);
    const label = !a.running ? 'stopped' : a.reachable ? 'running' : 'starting';
    const links = [];
    if (a.urls?.phone) links.push(`<a href="${esc(a.urls.phone)}" target="_blank" rel="noopener">phone: ${esc(a.urls.phone)}</a>`);
    if (a.urls?.desktop) links.push(`<a href="${esc(a.urls.desktop)}" target="_blank" rel="noopener">laptop: ${esc(a.urls.desktop)}</a>`);

    // The built-in Distributed Orchestrator app is special: it *is* the running harness, its
    // sessions edit the orchestrator itself, and it cannot be started, edited as a
    // record, or deleted.
    const meta = a.builtin
      ? `<div class="s dim">the orchestrator itself — sessions here edit its code</div>`
      : `<div class="s">${esc(shortDir(a.dir))}</div>
         ${a.running && a.reachable && links.length ? `<div class="s app-links">${links.join('<br>')}</div>` : ''}`;
    const pill = a.builtin
      ? '<span class="pill self">self</span>'
      : !launchable && !a.running && !a.lastStartedAt && !a.hasBeenApp ? '<span class="pill">chat</span>'
      : `<span class="pill ${a.reachable ? 'ready' : a.running ? 'warm' : ''}">${label}</span>`;
    const actions = a.builtin
      ? `<div class="app-actions">
          <button class="x" data-harness-restart="1" title="Restart Harness on all paired computers to apply code changes">⟳</button>
        </div>`
      : `<div class="app-actions">
          ${launchable || a.running ? `<button class="x" data-app-run="${esc(a.id)}" title="${a.running ? 'Stop' : 'Start'}">${a.running ? '■' : '▶'}</button>` : ''}
          <button class="x" data-app-edit="${esc(a.id)}" title="Edit project">✎</button>
        </div>`;

    return `<div class="app-block${a.builtin ? ' builtin' : ''}">
      <div class="item app-card" data-app-toggle="${esc(a.id)}">
        <span class="app-caret">›</span>
        <div class="grow">
          <div class="t">${esc(a.name)} ${pill}</div>
          ${meta}
          <div class="s dim">${mine.length} session${mine.length === 1 ? '' : 's'}</div>
        </div>
        ${actions}
      </div>
    </div>`;
  };

  const appsHtml = (() => {
    const groups = projectGroups(d.apps);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recentCandidates = state.sessions.filter((session) => (session.updatedAt ?? session.createdAt ?? 0) >= cutoff);
    const active = recentCandidates.filter((session) => (state.busy ?? []).includes(session.id));
    const recent = recentCandidates
      .filter((session) => !(state.busy ?? []).includes(session.id))
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
      .slice(0, 10);
    const recentSessions = [...active, ...recent];
    const inactiveLoose = loose.filter((session) => !(state.busy ?? []).includes(session.id));
    const disclosure = (id, label, count, content) => count
      ? `<details class="project-group" data-project-group="${id}"${openProjectGroups.has(id) ? ' open' : ''}><summary>${label} (${count})</summary>${content}</details>` : '';
    return disclosure('recent', `Recent sessions${active.length ? ` · ${active.length} active` : ''}`,
      recentSessions.length, recentSessions.map(sessionRow).join(''))
      + groups.visible.map(appCard).join('')
      + disclosure('stopped', 'Not running apps', groups.stopped.length, groups.stopped.map(appCard).join(''))
      + disclosure('chats', 'Chats', groups.chats.length + inactiveLoose.length,
        groups.chats.map(appCard).join('') + inactiveLoose.map(sessionRow).join(''));
  })();

  openSheet(`<h2>Apps &amp; Chats</h2>${appsHtml}<div id="peer-sessions"></div>
    <div class="actions">
      <button class="primary" id="app-new">new project</button>
      <button class="ghost" id="sess-new">new session</button>
    </div>`, 'apps');
  $('sheet').querySelectorAll('[data-project-group]').forEach((el) => {
    el.ontoggle = () => {
      if (el.open) openProjectGroups.add(el.dataset.projectGroup);
      else openProjectGroups.delete(el.dataset.projectGroup);
    };
  });
  if (scroll) $('sheet').scrollTop = scroll;

  // --- app-level actions ---
  showPeerSessions();
  $('app-new').onclick = () => appEditSheet(null);
  $('sess-new').onclick = () => { draft = {}; newSheet(); };
  $('sheet').querySelectorAll('[data-app-toggle]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('.app-actions') || e.target.closest('a')) return;  // buttons/links are their own
      if (el.dataset.opening) return;
      el.dataset.opening = '1';
      openProject(d.apps.find((a) => a.id === el.dataset.appToggle))
        .finally(() => { delete el.dataset.opening; });
    };
  });
  $('sheet').querySelectorAll('[data-app-edit]').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); appEditSheet(d.apps.find((a) => a.id === el.dataset.appEdit)); };
  });
  $('sheet').querySelectorAll('[data-app-run]').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); runApp(d.apps.find((a) => a.id === el.dataset.appRun), el); };
  });
  $('sheet').querySelectorAll('[data-harness-restart]').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      await restartOrchestrator(el);
    };
  });
  $('sheet').querySelectorAll('[data-new-in]').forEach((el) => {
    el.onclick = () => { draft = { appId: el.dataset.newIn }; newSheet(); };
  });

  // --- session-level actions ---
  $('sheet').querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.dataset.del || e.target.dataset.rename) return;
      openSession(el.dataset.open);
    };
  });
  $('sheet').querySelectorAll('[data-rename]').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      await openSession(el.dataset.rename);
      await sessionSettingsSheet();
    };
  });
  $('sheet').querySelectorAll('[data-del]').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      const id = el.dataset.del;
      if (!confirm('Delete this session?')) return;
      await api(`/api/sessions/${id}`, { method: 'DELETE' });
      if (state.session?.id === id) { state.session = null; drawTranscript(); paintHeader(); }
      state.sessions = state.sessions.filter((x) => x.id !== id);   // gone now, not after the refetch
      appsSheet();
    };
  });
}

/** Start or stop an app, with clear feedback. Shared by the app card. */
async function runApp(app, el) {
  if (!app.running && !app.start?.trim()) {
    showBanner(`${app.name} has no start command yet — add one here, then tap ▶`, true);
    appEditSheet(app);
    return;
  }
  if (el) { el.disabled = true; el.textContent = '…'; }
  showBanner(app.running ? `stopping ${app.name}…` : `starting ${app.name}…`);
  try {
    const r = await api(`/api/apps/${app.id}/${app.running ? 'stop' : 'start'}`, { method: 'POST' });
    if (r.unconfirmed) showBanner(`${app.name} did not confirm it stopped — something is still holding its port`, true);
    else if (r.launchdRemoved?.length) showBanner(`${app.name} stopped — also unregistered its background service so it stays down`);
    else if (app.running) showBanner(`${app.name} stopped`);
    else {
      const fresh = (await api('/api/apps')).apps.find((x) => x.id === app.id);
      if (fresh?.reachable) showBanner(`${app.name} is running — laptop ${fresh.urls.desktop}${fresh.urls.phone ? ` · phone ${fresh.urls.phone}` : ''}`);
      else showBanner(`${app.name} was launched but is not answering yet — check its log (✎ → view log) if it doesn't come up`, true);
    }
  } catch (e) { showBanner(e.message, true); }
  appsSheet();
}

/**
 * GitHub visibility for one app, inside its edit sheet.
 *
 * Read on open so it reflects the true state on GitHub, not a guess. Making a
 * repo public is hard to undo, so that direction takes a second, deliberate
 * tap rather than a single one.
 */
async function paintAppVisibility(app) {
  const box = $('ap-vis');
  if (!box) return;
  let v;
  try { v = await api(`/api/apps/${app.id}/git`); }
  catch (e) { box.innerHTML = `<p class="dim">${esc(e.message)}</p>`; return; }
  if (!v.ok) {
    box.innerHTML = `<p class="dim">${esc(v.reason || 'visibility unavailable')} — is <span class="mono">gh</span> signed in?</p>`;
    return;
  }
  const isPublic = v.visibility === 'public';
  box.innerHTML = `
    <div class="row">
      <button class="ghost${isPublic ? '' : ' on'}" data-setvis="private">🔒 private</button>
      <button class="ghost${isPublic ? ' on' : ''}" data-setvis="public">🌐 public</button>
    </div>
    <p class="dim">${isPublic
      ? 'Anyone can see this repository.'
      : 'Only you can see this repository.'} <a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.repo)}</a></p>`;

  box.querySelectorAll('[data-setvis]').forEach((el) => {
    el.onclick = async () => {
      const want = el.dataset.setvis;
      if (want === v.visibility) return;
      // Public is the irreversible-feeling direction; confirm it explicitly.
      if (want === 'public' && el.dataset.armed !== '1') {
        el.dataset.armed = '1';
        el.textContent = '🌐 tap again to make public';
        setTimeout(() => { el.dataset.armed = ''; el.textContent = '🌐 public'; }, 3000);
        return;
      }
      box.innerHTML = '<p class="dim">changing…</p>';
      try {
        const r = await api(`/api/apps/${app.id}/visibility`, { method: 'POST', body: JSON.stringify({ visibility: want }) });
        showBanner(r.ok ? `${app.name} is now ${want} on GitHub` : `couldn't change: ${r.reason}`, !r.ok);
      } catch (e) { showBanner(e.message, true); }
      paintAppVisibility(app);
    };
  });
}

function appEditSheet(app = null, draft = null) {
  const existing = Boolean(app?.id);
  const a = draft ?? app ?? { name: '', dir: '', start: '', repo: '' };

  openSheet(`<h2>${existing ? 'Edit project' : 'New project'}</h2>
    <label>Name</label><input id="ap-name" value="${esc(a.name ?? '')}" spellcheck="false" placeholder="what you're building" />
    ${existing ? '<p class="dim">Renaming this project also renames its linked GitHub repository. Its folder stays in place.</p>' : ''}
    <label>Folder${existing ? '' : ' — made for you from the name'}</label>
    <div class="row"><input id="ap-dir" value="${esc(a.dir ?? '')}" spellcheck="false" ${existing ? 'disabled' : ''} />
      ${existing ? '' : '<button class="ghost" id="ap-browse" style="flex:0 0 80px">browse</button>'}</div>
    <label>Start command (optional)</label>
    <p class="dim">Leave empty for a Chat with sessions and no play button. Add a command to make it a launchable app.</p>
    <input id="ap-start" value="${esc(a.start ?? '')}" spellcheck="false" placeholder="npm run dev" />
    <p class="dim">Runs in the app's folder with <span class="mono">PORT</span> set${existing ? ` to ${app.port}` : ' to the port this app is given'}.</p>
    <label>Repository (optional)</label>
    <input id="ap-repo" value="${esc(a.repo ?? '')}" spellcheck="false" placeholder="git@github.com:you/app.git" />
    <div id="ap-machines"></div>
    ${existing && a.repo ? `<label>GitHub visibility</label>
      <div id="ap-vis"><p class="dim">checking…</p></div>` : ''}
    <div class="actions">
      <button class="primary" id="ap-save">${existing ? 'save' : 'create project'}</button>
      <button class="ghost" id="ap-back">back</button>
      ${existing ? '<button class="ghost" id="ap-log">view log</button><button class="ghost" id="ap-del">delete</button>' : ''}
    </div>`);

  const values = () => ({
    name: $('ap-name').value, dir: $('ap-dir').value,
    start: $('ap-start').value, repo: $('ap-repo').value,
    hosts: $('ap-machines')?.querySelector('[data-host]')
      ? [...$('ap-machines').querySelectorAll('[data-host]:checked')].map((el) => el.dataset.host) : undefined,
  });

  // Every app gets its own folder under ~/Projects without the user typing a
  // path. Typing in the field yourself stops the suggestion taking over.
  if (!existing) {
    let touched = Boolean(a.dir);
    const slugify = (t) => t.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const suggest = () => {
      if (touched) return;
      const name = slugify($('ap-name').value);
      $('ap-dir').value = name ? `${state.home}/Projects/${name}` : '';
    };
    $('ap-name').addEventListener('input', suggest);
    $('ap-dir').addEventListener('input', () => { touched = true; });
    suggest();
    $('ap-browse').onclick = () => browseSheet($('ap-dir').value || `${state.home}/Projects`,
      (chosen) => appEditSheet(app, { ...values(), dir: chosen }),
      () => appEditSheet(app, values()));
  }

  $('ap-back').onclick = appsSheet;
  if ($('ap-vis')) paintAppVisibility(app);
  const machines = paintAppMachines(app, a.hosts);

  if ($('ap-log')) $('ap-log').onclick = async () => {
    const text = await (await fetch(`/api/apps/${app.id}/log`)).text();
    openSheet(`<h2>Log — ${esc(app.name)}</h2><pre class="log">${esc(text.slice(-8000) || '(empty)')}</pre>`
      + `<div class="actions"><button class="ghost" id="lb">back</button></div>`);
    $('lb').onclick = () => appEditSheet(app);
  };
  if ($('ap-del')) $('ap-del').onclick = () => appDeleteSheet(app);
  $('ap-save').onclick = async () => {
    const v = values();
    const body = { name: v.name.trim(), start: v.start.trim(), repo: v.repo.trim() || null };
    const hosts = await machines;
    if (hosts) body.hosts = hosts();
    if (!body.name && !existing) return showBanner('give the app a name');
    try {
      if (existing) await api(`/api/apps/${app.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else {
        const made = await api('/api/apps', { method: 'POST', body: JSON.stringify({ ...body, dir: v.dir.trim() }) });
        expandedApps.add(made.id);
        await refreshState();
      }
      appsSheet();
    } catch (e) { showBanner(e.message, true); }
  };
}

/**
 * Which machines keep a copy of this project, inside its edit sheet.
 *
 * Shown only once another machine has joined. Returns a reader for the ticked
 * machines, or null when there is no choice to make. New projects start on
 * their original host; additional hosts can own their own tabs.
 */
async function paintAppMachines(app, draft) {
  const box = $('ap-machines');
  let data;
  try { data = await api('/api/cluster/status'); } catch { return null; }
  const hosts = data.hosts.filter((h) => h.member);
  if (!box?.isConnected || hosts.length < 2) return null;
  const states = Object.fromEntries((app?.machines || []).map((m) => [m.id, m]));
  const placed = new Set(draft || (app?.machines ? app.machines.filter((m) => m.placed).map((m) => m.id) : [data.leader]));
  const ownerId = app?.ownerNode || app?.hosts?.[0] || data.leader;
  placed.add(ownerId);
  const owner = hosts.find((h) => h.id === ownerId);
  const main = hosts.find((h) => h.id === data.leader);
  const note = (m) => {
    if (!m?.state) return '';
    if (m.state === 'ready') return m.error ? `copy ready · ${m.error}` : 'copy ready';
    if (m.state === 'pending') return 'copy being made';
    return m.error || m.state;
  };
  box.innerHTML = `<label>Machines</label>
    <p class="dim">Hosted on ${esc(owner?.name || 'its original computer')}. Select additional computers to replicate this app through its Git repository. Each selected computer can own tabs and use its own AI sources. Tabs sync through Git and merge and test before publishing; conflicts keep their work separate. Harness is always enabled on every joined computer. Unticking a machine deletes its copy once everything in it is pushed; a copy with unsaved work is kept and flagged.</p>
    ${hosts.map((h) => `<div class="item"><label class="grow"><input type="checkbox" data-host="${esc(h.id)}" ${placed.has(h.id) ? 'checked' : ''}${h.id === ownerId ? ' disabled' : ''} />
      ${esc(h.name)}${h.id === data.leader ? ' · main' : ''}${h.active ? '' : ' · offline'}${h.id === ownerId ? ' · app host' : ' · replicate here'}
      ${note(states[h.id]) ? `<div class="s">${esc(note(states[h.id]))}</div>` : ''}</label></div>`).join('')}`;
  return () => [...box.querySelectorAll('[data-host]')].filter((el) => el.checked).map((el) => el.dataset.host);
}

/**
 * Deleting an app, with the consequences spelled out.
 *
 * Removing the record is cheap and reversible — recreate the app and point it
 * at the same folder. Deleting the folder is neither, so it is off by default,
 * named in full, and needs a second tap that says what it is about to erase.
 */
async function appDeleteSheet(app) {
  let mine = [];
  try {
    await refreshState();
    mine = state.sessions.filter((x) => x.appId === app.id);
  } catch { /* the counts are a courtesy, not a gate */ }

  openSheet(`<h2>Delete ${esc(app.name)}</h2>
    <p class="dim">Stopping it, retiring its Tailscale address and discarding its log happens either way.</p>
    <label>Also delete</label>
    <div class="item">
      <label class="grow"><input type="checkbox" id="del-files" />
        the folder <span class="mono">${esc(shortDir(app.dir))}</span> and everything in it</label>
    </div>
    <div class="item">
      <label class="grow"><input type="checkbox" id="del-sessions" ${mine.length ? '' : 'disabled'} />
        ${mine.length ? `its ${mine.length} session${mine.length === 1 ? '' : 's'} and their transcripts` : 'no sessions are attached'}</label>
    </div>
    ${app.repo ? `<div class="item"><label class="grow"><input type="checkbox" id="del-github" />
      its GitHub repository: ${esc(app.repo)}</label></div>
      <label>To delete GitHub too, type owner/repository</label>
      <input id="del-repo-confirm" autocomplete="off" spellcheck="false" placeholder="owner/repository" />` : ''}
    <p class="dim" id="del-warn"></p>
    <div class="actions">
      <button class="ghost" id="del-cancel">cancel</button>
      <button class="primary danger" id="del-go">delete app</button>
    </div>`);

  const warn = () => {
    delete $('del-go').dataset.armed;
    const f = $('del-files').checked;
    const s2 = $('del-sessions').checked;
    const g = $('del-github')?.checked;
    $('del-warn').textContent = f || s2 || g
      ? `This cannot be undone. ${[g ? app.repo : null, f ? shortDir(app.dir) : null, s2 ? `${mine.length} transcript${mine.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ')} will be erased.`
      : 'The folder stays on disk; only the orchestrator forgets the app.';
    $('del-go').textContent = f || s2 || g ? 'delete permanently' : 'remove from orchestrator';
  };
  $('del-files').onchange = warn;
  $('del-sessions').onchange = warn;
  if ($('del-github')) $('del-github').onchange = warn;
  if ($('del-repo-confirm')) $('del-repo-confirm').oninput = warn;
  warn();

  $('del-cancel').onclick = () => appEditSheet(app);
  $('del-go').onclick = async () => {
    const f = $('del-files').checked;
    const s2 = $('del-sessions').checked;
    const g = $('del-github')?.checked;
    // A second tap for the irreversible half, because this is a phone and the
    // first one is easy to hit by accident.
    if ((f || s2 || g) && $('del-go').dataset.armed !== '1') {
      $('del-go').dataset.armed = '1';
      $('del-go').textContent = 'tap again to erase';
      return;
    }
    $('del-go').disabled = true;
    try {
      const r = await api(`/api/apps/${app.id}?files=${f ? 1 : 0}&sessions=${s2 ? 1 : 0}&github=${g ? 1 : 0}`, { method: 'DELETE', body: JSON.stringify({ confirmRepository: $('del-repo-confirm')?.value.trim() }) });
      // Report what actually happened rather than assuming it all worked.
      const bits = [];
      if (r.deletedRepo) bits.push('GitHub repository deleted: ' + r.deletedRepo);
      if (r.stopped === false) bits.push('it would not confirm it stopped');
      if (r.dirError) bits.push(`the folder was kept: ${r.dirError}`);
      if (f && r.dir) bits.push('folder deleted');
      if (r.removedSessions?.length) bits.push(`${r.removedSessions.length} session(s) deleted`);
      if (bits.length) showBanner(`${r.name}: ${bits.join(' · ')}`, Boolean(r.dirError || r.stopped === false));
      appsSheet();
    } catch (e) {
      showBanner(e.message, true);
      $('del-go').disabled = false;
    }
  };
}

async function usageSheet() {
  let d;
  try {
    d = await api(`/api/usage?window=${usageWindow}`);
  } catch (e) {
    return openSheet(`<h2>Usage</h2><p class="dim">${esc(e.message)}</p>`);
  }

  const money = (n) => (n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : '$0');
  const spend = d.models.reduce((n, m) => n + (m.cost || 0), 0);

  /**
   * One card per model, all the same weight.
   *
   * Only some backends report a limit. Both subscription CLIs send real
   * window utilisation — Claude Code down its stream, Codex via the rollout
   * file its turn leaves behind — while a metered API has no ceiling to show.
   * Rather than inventing a percentage for the ones that do not publish one,
   * each card says what is actually known about it.
   */
  const card = (m) => {
    const p = d.provider?.[m.alias];
    const windows = p?.windows ?? [];

    let limit;
    if (windows.length) {
      limit = windows.map((w) => `
        <div class="meter">
          <div class="meter-head"><span>${esc(WINDOW_LABEL[w.name] ?? w.name)}</span>
            <span class="mono">${(w.pct * 100).toFixed(w.pct < 0.1 ? 1 : 0)}%</span></div>
          ${bar(w.pct, w.pct > 0.9 ? 'hot' : w.pct > 0.7 ? 'warm' : '')}
          <div class="s">${esc(untilReset(w.resetsAt))}</div>
        </div>`).join('');
    } else if (m.provider === 'codex-cli' || m.provider === 'claude-cli') {
      limit = '<p class="s">Plan limits apply — the figure arrives with this model\'s next turn.</p>';
    } else if (m.limit) {
      limit = `<div class="meter">
        <div class="meter-head"><span>${m.limit.kind === 'cost' ? 'budget' : 'token limit'}</span>
          <span class="mono">${(m.limit.pct * 100).toFixed(0)}%</span></div>
        ${bar(m.limit.pct, m.limit.pct > 0.9 ? 'hot' : m.limit.pct > 0.7 ? 'warm' : '')}</div>`;
    } else {
      limit = '<p class="s">Metered — no ceiling. You pay per token.</p>';
    }

    const cachedShare = m.input ? Math.min(100, Math.round((m.cached / m.input) * 100)) : 0;
    return `<div class="item usage-card">
      <div class="tool-head" style="padding:0">
        <span class="t" style="flex:1">${esc(m.label)}</span>
        <span class="spend-amt">${m.cost > 0 ? money(m.cost) : m.turns ? 'no charge' : '—'}</span>
      </div>
      <div class="s">${esc(m.provider)} · ${m.turns} turns · ${num(m.input)} in (${cachedShare}% cached) · ${num(m.output)} out</div>
      ${limit}
    </div>`;
  };

  // Used first, then the rest — but every card is the same size and shape.
  const ordered = [...d.models].sort((a, b) => b.turns - a.turns);

  openSheet(`<h2>Usage</h2>
    <div class="row" style="margin-bottom:12px">
      ${d.windows.map((w) => `<button class="ghost win${w === d.window ? ' on' : ''}" data-win="${w}">${esc(WINDOW_LABEL[w] ?? w)}</button>`).join('')}
    </div>
    ${ordered.map(card).join('')}
    <p class="dim">${money(spend)} metered spend in this window. Subscription models bill against
      their plan instead, so they show no charge.</p>
    <div class="actions"><button class="primary" id="u-close">done</button></div>`);

  $('u-close').onclick = closeSheet;
  $('sheet').querySelectorAll('[data-win]').forEach((el) => {
    el.onclick = () => { usageWindow = el.dataset.win; usageSheet(); };
  });
}

$('usage').onclick = usageSheet;

// ------------------------------------------------------------- file browser

const humanSize = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};

const FILE_ICON = { image: '🖼', text: '📄', pdf: '📕', other: '📦' };

let filesAt = null;   // remembered so reopening lands where you left off

async function filesSheet(start) {
  const where = start ?? filesAt ?? state.session?.projectDir ?? state.home;
  let d;
  try {
    d = await api(`/api/files?path=${encodeURIComponent(where)}`);
  } catch (e) {
    openSheet(`<h2>Files</h2><p class="dim">${esc(e.message)}</p>
      <div class="actions"><button class="ghost" id="f-home">go home</button></div>`);
    $('f-home').onclick = () => filesSheet(state.home);
    return;
  }
  filesAt = d.path;

  const rows = [
    d.parent ? `<div class="item" data-dir="${esc(d.parent)}"><div class="grow"><div class="t">../</div></div></div>` : '',
    ...d.dirs.map((x) => `<div class="item" data-dir="${esc(x.path)}">
        <div class="grow"><div class="t">📂 ${esc(x.name)}</div></div></div>`),
    ...d.files.map((f) => `<div class="item" data-file="${esc(f.path)}" data-kind="${f.kind}">
        <div class="grow"><div class="t">${FILE_ICON[f.kind]} ${esc(f.name)}</div>
        <div class="s">${humanSize(f.size)}</div></div></div>`),
  ].join('');

  openSheet(`<h2>Files</h2>
    <p class="dim">${esc(shortDir(d.path))}</p>
    ${d.note ? `<p class="dim warn-text">${esc(d.note)}</p>` : ''}
    ${rows || '<p class="dim">empty folder</p>'}
    <div class="actions">
      <button class="ghost" id="f-back">‹ settings</button>
      ${state.session ? '<button class="ghost" id="f-proj">project folder</button>' : ''}
      <button class="primary" id="f-close">done</button>
    </div>`);

  $('f-close').onclick = closeSheet;
  $('f-back').onclick = settingsSheet;
  if ($('f-proj')) $('f-proj').onclick = () => filesSheet(state.session.projectDir);
  $('sheet').querySelectorAll('[data-dir]').forEach((el) => {
    el.onclick = () => filesSheet(el.dataset.dir);
  });
  $('sheet').querySelectorAll('[data-file]').forEach((el) => {
    el.onclick = () => viewFile(el.dataset.file, el.dataset.kind);
  });
}

async function viewFile(file, kind) {
  const name = file.split('/').pop();
  const src = nodeApi(`/api/file?path=${encodeURIComponent(file)}&session=${encodeURIComponent(state.session?.id || '')}`);
  const back = `<div class="actions"><button class="ghost" id="v-back">back</button>
    <button class="primary" id="v-close">done</button></div>`;

  if (kind === 'image') {
    openSheet(`<h2>${esc(name)}</h2>
      <img src="${src}" alt="${esc(name)}" style="width:100%;border:1px solid var(--line);border-radius:10px" />
      ${back}`);
  } else if (kind === 'pdf') {
    // iOS Safari will not inline a PDF in a sheet; open it in its own tab.
    openSheet(`<h2>${esc(name)}</h2>
      <p class="dim"><a href="${src}" target="_blank" rel="noopener" style="color:var(--accent)">open ${esc(name)}</a></p>
      ${back}`);
  } else {
    let text;
    try {
      text = await (await fetch(src)).text();
    } catch (e) {
      text = `could not read: ${e.message}`;
    }
    openSheet(`<h2>${esc(name)}</h2>
      <pre class="file-body">${esc(text)}</pre>${back}`);
  }

  $('v-back').onclick = () => filesSheet(filesAt);
  $('v-close').onclick = closeSheet;
}


// --------------------------------------------------------- laptop's screen

$('menu').onclick = sessionsSheet;
$('gear').onclick = settingsSheet;
function paintPending() {
  paintComposerAction();
  const box = $('pending');
  box.hidden = pendingShots.length === 0;
  box.innerHTML = pendingShots.map((a, i) => `
    <div class="thumb${a.uploading ? ' busy' : ''}">
      ${a.preview ? `<img src="${a.preview}" alt="">` : ''}
      <button class="drop" data-drop-shot="${i}" aria-label="Remove">×</button>
    </div>`).join('');
  box.querySelectorAll('[data-drop-shot]').forEach((el) => {
    el.onclick = () => {
      pendingShots.splice(Number(el.dataset.dropShot), 1);
      paintPending();
    };
  });
}

$('attach').onclick = () => {
  if (!cur().session) return showBanner('open a session first — tap ☰');
  $('pick').click();
};

async function attachFiles(files) {
  const session = cur().session;
  if (!session) return showBanner('open a session first — tap ☰');

  for (const file of files) {
    const entry = { name: file.name, uploading: true, preview: URL.createObjectURL(file) };
    pendingShots.push(entry);
    paintPending();
    try {
      const res = await fetch(`/api/sessions/${session.id}/upload`, {
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `upload failed (${res.status})`);
      Object.assign(entry, body, { uploading: false });
    } catch (e) {
      pendingShots = pendingShots.filter((x) => x !== entry);
      showBanner(e.message);
    }
    paintPending();
  }
}

$('pick').onchange = () => {
  const files = [...$('pick').files];
  $('pick').value = ''; // choosing the same file again still triggers change
  return attachFiles(files);
};

// Only intercept file paste in the composer; ordinary text keeps native paste.
$('input').addEventListener('paste', (event) => {
  const clipboard = event.clipboardData;
  if (!clipboard) return;
  let files = [...(clipboard.files ?? [])];
  if (!files.length) {
    files = [...(clipboard.items ?? [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile()).filter(Boolean);
  }
  if (!files.length) return;
  event.preventDefault();
  attachFiles(files);
});

$('send').onclick = () => send();
$('queue').onclick = () => send(true);
$('stop').onclick = () => api(`/api/sessions/${cur().session.id}/stop`, { method: 'POST' });

$('sheet-back').onclick = (e) => {
  if (e.target.id !== 'sheet-back') return;
  clearInterval(jobsTimer);
  jobsTimer = null;
  closeSheet();
};

$('input').addEventListener('input', (e) => {
  paintComposerAction();
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(e.target.scrollHeight, window.innerHeight * 0.4)}px`;
});

$('transcript').addEventListener('scroll', () => {
  const el = $('transcript');
  pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
});

// Tap the chip to see what actually ran; tap a step inside it for its output.
$('transcript').addEventListener('click', async (e) => {
  const copy = e.target.closest('.copy-reply');
  if (copy) {
    // Inside the fold header's own click target, so stop it toggling the fold.
    e.stopPropagation();
    const text = copyTexts.get(copy.dataset.copy);
    if (text == null) return;
    const ok = await copyText(text);
    // Say what happened. A copy button that silently failed is the sort of
    // thing you only discover after pasting nothing into the other session.
    // When it cannot copy, it selects the reply instead, so the fallback is
    // one long-press away rather than a dead end.
    if (!ok) selectReply(copy);
    // Kept short: this sits in a header beside the model name on a phone.
    copy.textContent = ok ? 'copied' : 'selected';
    copy.title = ok ? '' : 'Clipboard unavailable here — long-press the highlighted text to copy';
    copy.classList.toggle('failed', !ok);
    setTimeout(() => {
      copy.textContent = 'copy';
      copy.classList.remove('failed');
    }, ok ? 1200 : 3000);
    return;
  }

  const erase = e.target.closest('[data-erase]');
  if (erase) {
    e.stopPropagation();          // these sit inside a fold header
    if (!confirm('Delete this message? It is removed from the conversation and from the context sent to the model.')) return;
    await editTranscript('erase', { eventId: erase.dataset.erase });
    return;
  }

  const rewind = e.target.closest('[data-rewind]');
  if (rewind) {
    e.stopPropagation();
    if (!confirm('Rewind to here? This message and everything after it are removed from the conversation.')) return;
    // Offered second, so the conversation can be wound back without touching
    // the files if that is all that is wanted.
    const revertFiles = false; // File changes are reversed through a new, ordered coding turn.
    await editTranscript('rewind', { eventId: rewind.dataset.rewind, revertFiles });
    return;
  }

  const fold = e.target.closest('[data-fold]');
  if (fold) {
    const key = fold.dataset.fold;
    const body = $(`fold-${key}`);
    if (body) {
      body.hidden = !body.hidden;
      // Record the choice explicitly, so a re-render mid-stream cannot quietly
      // reopen something just closed.
      if (body.hidden) { closedFolds.add(key); openedFolds.delete(key); }
      else { openedFolds.add(key); closedFolds.delete(key); }
      fold.setAttribute('aria-expanded', String(!body.hidden));
      fold.querySelector('.act-caret').textContent = body.hidden ? '▾' : '▴';
    }
    return;
  }

  const card = e.target.closest('.file-card');
  if (card) {
    if (e.target.closest('.file-dl')) return;   // let the download link do its job
    viewFile(card.dataset.openFile, card.dataset.fileKind);
    return;
  }

  const chip = e.target.closest('.act');
  if (chip) {
    const detail = $(`act-${chip.dataset.act}`);
    if (detail) {
      detail.hidden = !detail.hidden;
      chip.querySelector('.act-caret').textContent = detail.hidden ? '▾' : '▴';
    }
    return;
  }
  const head = e.target.closest('.tool-head');
  if (!head) return;
  const body = head.parentElement.querySelector('.tool-body');
  if (body) body.hidden = !body.hidden;
});

/**
 * On a phone the stream is not reliable: the radio sleeps, the tab backgrounds,
 * the connection drops on a cell handover. EventSource reconnects itself, but a
 * missed `done` would leave the composer insisting a turn is still running, or
 * worse, showing idle while the laptop is busy. So the truth is re-checked
 * whenever the tab comes back, and on a slow timer while it is open.
 */
async function reconcile() {
  if (document.hidden || !state.session) return;
  try {
    await refreshState();
  } catch {
    // offline for the moment; the next tick will try again
  }
}

document.addEventListener('visibilitychange', reconcile);
window.addEventListener('online', reconcile);
setInterval(reconcile, 20_000);

(async () => {
  try { await refreshState(); } catch (e) { showBanner(e.message); machinesSheet(); return; }
  const last = new URLSearchParams(location.search).get('session') || localStorage.getItem(sessionStorageKey);
  if (last && state.sessions.some((s) => s.id === last)) await openSession(last);
  else paintHeader();
})();
