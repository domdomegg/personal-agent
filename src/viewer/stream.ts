/**
 * The viewer: the conversation as chat bubbles (Adam right, agent left),
 * with the agent's work between messages folded into one "worked · n steps"
 * line that opens to every tool call, output expandable inline. Service
 * chatter (restarts, scheduled runs, compactions) is a divider pill. For
 * talking to the agent, for watching a run happen, and for working out
 * afterwards why it did something odd.
 *
 * With `chat`, a message box sits at the bottom: what is typed there reaches
 * the agent as a web-channel event, and its replies show up as bubbles like
 * any other.
 *
 * Styling lives in one flat stylesheet; ?css=<name> layers /proto/<name>.css
 * on top for restart-free iteration.
 */
const COMPOSER = `<span id="composerNote"></span>
<form id="composer">
  <textarea id="message" rows="1" placeholder="message the agent" aria-label="message the agent"></textarea>
  <button type="submit" id="sendButton" aria-label="send" title="send"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
</form>`;

export function streamPage(options: {chat?: boolean} = {}): string {
	const chat = options.chat ?? false;
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #101113; --line: #22242a; --text: #e6e8ec; --dim: #8b9099;
    --me: #2f4f7f; --me-text: #eef3fb; --them: #1c1e23; --accent: #4f8cff;
    --tool: #7aa2f7; --err: #f7768e; --code-bg: #101318; --code-text: #aeb4bd;
    --add: #1d2b1d; --add-text: #b2dfae; --del: #2e1a1e; --del-text: #e8a7b0;
    --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #f6f7f9; --line: #e3e5ea; --text: #1b1d22; --dim: #6f7580;
      --me: #2f6fde; --me-text: #ffffff; --them: #ffffff; --accent: #2f6fde;
      --tool: #2f6fde; --code-bg: #eef0f4; --code-text: #30343b;
      --add: #e3f3df; --add-text: #1f5a1f; --del: #fbe4e7; --del-text: #7a1f2b;
    }
    .row.reply .body { box-shadow: 0 1px 2px rgba(0,0,0,.06); }
    #composer textarea { background: #fff; border-color: #d9dce3; }
    #jump { background: #fff; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 var(--font); }

  header {
    position: sticky; top: 0; z-index: 2; background: color-mix(in srgb, var(--bg) 90%, transparent);
    backdrop-filter: blur(8px); border-bottom: 1px solid var(--line);
    padding: 8px max(14px, calc((100% - 820px) / 2 + 14px)); display: flex; align-items: center; gap: 10px;
  }
  header h1 { font-size: 13px; margin: 0; font-weight: 600; letter-spacing: .04em; }
  nav { display: flex; gap: 2px; margin-left: auto; }
  nav a { color: var(--dim); text-decoration: none; padding: 4px 8px; border-radius: 6px; font-size: 13px; }
  nav a:hover { color: var(--text); }
  main { max-width: 820px; margin: 0 auto; padding: 10px 0 calc(var(--composer-h, 72px) + 28px); }
  .empty { color: var(--dim); text-align: center; padding: 48px 0; }

  /* Jump-to-latest: only shown when scrolled away from the bottom. */
  #jump {
    position: fixed; right: 16px; bottom: calc(var(--composer-h, 72px) + 16px); z-index: 3;
    background: var(--them); color: var(--text); border: 1px solid var(--line);
    border-radius: 999px; padding: 8px 14px; font: inherit; font-size: 13px; cursor: pointer;
    box-shadow: 0 4px 16px rgba(0,0,0,.25); display: none; align-items: center; gap: 7px;
  }
  #jump.show { display: flex; }
  #jump .n { color: var(--accent); }

  /* Conversation: bubbles, Adam right, agent left, time inside bottom-right. */
  .row { display: flex; gap: 10px; padding: 3px 14px; align-items: baseline; }
  .body { overflow-wrap: anywhere; white-space: pre-wrap; flex: 1; }
  .tag { display: none; }
  .row.incoming, .row.reply { flex-direction: column; padding: 6px 14px; }
  .row.incoming { align-items: flex-end; }
  .row.reply { align-items: flex-start; }
  .row.incoming .body, .row.reply .body {
    max-width: min(78%, 620px); padding: 9px 12px 9px 13px; border-radius: 16px; flex: none;
  }
  .row.incoming .body { background: var(--me); color: var(--me-text); border-bottom-right-radius: 5px; }
  .row.reply .body { background: var(--them); border-bottom-left-radius: 5px; }
  .row.from-group .body { background: #1f3a3a; color: #e6f3f1; }
  .row.from-group::before { content: 'group'; order: -1; font-size: 11px; color: var(--dim); margin: 0 4px 2px; }
  .t { display: none; }
  .t.inside { display: inline; float: right; margin: 6px 0 0 10px; font-size: 10.5px; line-height: 1; opacity: .65; position: relative; top: 4px; }
  .row.incoming .t.inside { color: var(--me-text); }
  .row.reply .t.inside { color: var(--dim); }
  .row.reply.failed .body { outline: 1px solid var(--err); }
  .row.reply.failed .body::after { content: ' · not delivered'; color: var(--err); font-size: 12px; }
  .row.pending { display: none; }               /* the optimistic echo stands in */
  .row.optimistic { display: flex; }
  .delivery { font-size: 11px; color: var(--dim); margin: 2px 6px 0; }
  .body a { color: inherit; text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); text-underline-offset: 2px; }
  .row.reply .body a { color: var(--accent); }

  /* Service chatter (restarts, scheduled runs, compactions) is a divider pill; tap for the full text. */
  .row.from-system { flex-direction: column; align-items: center; padding: 4px 14px; cursor: pointer; }
  .row.from-system .syslabel {
    font-size: 11px; line-height: 1.7; color: var(--dim); letter-spacing: .02em;
    padding: 2px 10px; border-radius: 999px; background: var(--them); opacity: .8;
    display: inline-block; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .row.from-system .sysfull { display: none; max-width: 90%; margin-top: 6px; font-size: 12px; color: var(--dim); }
  .row.from-system.open .sysfull { display: block; }

  /* The agent's work between two messages folds into one "worked · n steps" line. */
  .run {
    margin: 2px 14px 2px 22px; padding: 2px 8px; color: var(--dim); font-size: 12px; cursor: pointer; user-select: none;
    border-radius: 6px; width: fit-content;
  }
  .run::before { content: '▸ '; }
  .run.open::before { content: '▾ '; }
  .run:hover { background: var(--them); }
  .run.live { color: var(--accent); }
  .row.in-run { display: none; }
  .row.in-run.run-open { display: flex; }
  .row.tool, .row.notes {
    font: 12px/1.4 var(--mono); padding: 1px 14px 1px 24px; color: var(--dim);
    border-left: 2px solid var(--line); margin-left: 14px;
  }
  .row.tool .tag { display: block; flex: none; width: 38px; font-size: 11px; color: var(--tool); }
  .row.failed .tag { color: var(--err); }
  .row.tool .head { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; }
  .row.tool.open .head { display: block; }
  .row.tool .body b { font-weight: 600; color: var(--dim); filter: brightness(1.15); }
  .row.tool.running { background: var(--them); }
  .row.notes .body { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .row.notes.open .body { display: block; }
  .waiting { color: var(--accent); animation: blink 1.4s ease-in-out infinite; }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  details > summary { cursor: pointer; list-style: none; color: var(--dim); }
  details > summary::-webkit-details-marker { display: none; }
  details > summary::before { content: '▸ '; }
  details[open] > summary::before { content: '▾ '; }
  .shots { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 2px; }
  .shots img { max-width: min(100%, 720px); max-height: 420px; border: 1px solid var(--line); border-radius: 3px; background: var(--code-bg); }
  pre {
    margin: 6px 0 2px; padding: 8px 10px; background: var(--code-bg); color: var(--code-text);
    border-left: 2px solid var(--line); overflow-x: auto; max-height: 340px; white-space: pre-wrap;
  }
  .diff { margin: 6px 0 2px; border-left: 2px solid var(--line); max-height: 340px; overflow: auto; }
  .diff .file { color: var(--dim); padding: 4px 10px; background: var(--code-bg); }
  .diff .ln { padding: 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .diff .del { background: var(--del); color: var(--del-text); }
  .diff .add { background: var(--add); color: var(--add-text); }

  /* Typing dots while a turn runs: "thinking" when text is being generated, "running <tool>" during a call. */
  .typing { display: flex; gap: 4px; align-items: center; margin: 6px 14px 10px; padding: 12px 14px; background: var(--them); border-radius: 16px; border-bottom-left-radius: 5px; width: fit-content; }
  .typing span:not(.lbl) { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); animation: tdot 1.2s ease-in-out infinite; }
  .typing.doing span:not(.lbl) { background: var(--accent); }
  .typing span:nth-child(2):not(.lbl) { animation-delay: .2s; }
  .typing span:nth-child(3):not(.lbl) { animation-delay: .4s; }
  .typing .lbl { font-size: 11px; color: var(--dim); margin-left: 6px; white-space: nowrap; }
  @keyframes tdot { 0%, 60%, 100% { opacity: .3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }

  /* Message box, pinned to the bottom, same column as the thread, same background as the page. */
  #composer {
    position: fixed; left: 50%; transform: translateX(-50%); bottom: 0; z-index: 2; width: min(100%, 820px);
    background: var(--bg); padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
    display: flex; gap: 8px; align-items: flex-end;
  }
  #composer textarea {
    flex: 1; min-width: 0; resize: none; min-height: 44px;
    background: var(--them); color: var(--text); border: 1px solid var(--line); border-radius: 22px;
    padding: 10px 16px; font: inherit; font-size: 16px; /* 16px stops iOS zooming on focus */
  }
  #composer textarea:focus { outline: none; border-color: var(--accent); }
  #sendButton {
    flex: none; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
    background: var(--accent); color: #fff; display: inline-flex; align-items: center; justify-content: center;
  }
  #sendButton:disabled { opacity: .5; cursor: default; }
  #composerNote { position: fixed; left: 14px; bottom: calc(var(--composer-h, 72px) + 4px); z-index: 2; color: var(--dim); font-size: 12px; }
  #composerNote.err { color: var(--err); }

  @media (max-width: 640px) {
    nav a[href="/connect"] { display: none; }
    .row.incoming .body, .row.reply .body { max-width: 88%; }
  }
</style>
<header>
  <h1>AGENT</h1>
  <nav><a href="/desktop" target="_blank">desktop</a> <a href="/connect">connect</a></nav>
</header>
<main id="root"><div class="empty">loading…</div></main>
<button id="jump">↓ latest<span class="n" id="jumpCount"></span></button>
${chat ? COMPOSER : ''}
<script>
const CHAT = ${chat ? 'true' : 'false'};
(() => {
  // Prototyping: ?css=<name> layers /proto/<name>.css over the built-in styles
  // (no restart needed to iterate); ?css= clears it.
  const c = new URLSearchParams(location.search).get('css');
  if (c !== null) { if (c) localStorage.setItem('css', c); else localStorage.removeItem('css'); history.replaceState(null, '', location.pathname + location.hash); }
  const css = localStorage.getItem('css');
  if (css) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/proto/' + encodeURIComponent(css) + '.css?v=' + Date.now(); document.head.append(l); }
})();
// Long tool commands are clamped; tap the head to see the whole thing.
document.addEventListener('click', (ev) => {
  const head = ev.target.closest('.row.tool .head, .row.notes .body, .row.from-system');
  if (head) head.closest('.row').classList.toggle('open');
});
const root = document.getElementById('root');
const jump = document.getElementById('jump');
const jumpCount = document.getElementById('jumpCount');
const opened = new Set();
let latest = [];
let seen = -1;
let changedAt = 0;
// Rows that arrived while scrolled away, so the button can say how many.
let unseenRows = 0;

const NEAR_BOTTOM = 120;
const atBottom = () => window.innerHeight + window.scrollY >= document.body.offsetHeight - NEAR_BOTTOM;

function toBottom() {
  window.scrollTo({top: document.body.scrollHeight, behavior: 'smooth'});
  unseenRows = 0;
  syncJump();
}

function syncJump() {
  const show = !atBottom();
  jump.classList.toggle('show', show);
  jumpCount.textContent = show && unseenRows ? ' ' + unseenRows : '';
  if (!show) unseenRows = 0;
}

jump.onclick = toBottom;
window.addEventListener('scroll', syncJump, {passive: true});

const time = (iso) => {
  if (!iso) return '--:--:--';
  return new Date(iso).toLocaleTimeString([], {hour12: false});
};

// A details element that survives the once-a-second re-render.
function keepOpen(d, key) {
  d.open = opened.has(key);
  d.addEventListener('toggle', () => {
    if (d.open) opened.add(key); else opened.delete(key);
  });
}

function diffBlock(detail) {
  const wrap = document.createElement('div');
  wrap.className = 'diff';
  const file = document.createElement('div');
  file.className = 'file';
  file.textContent = detail.filePath + (detail.replaceAll ? '  (replace all)' : '');
  wrap.append(file);
  const side = (text, cls, sign) => {
    for (const line of text.split('\\n')) {
      const el = document.createElement('div');
      el.className = 'ln ' + cls;
      el.textContent = sign + ' ' + line;
      wrap.append(el);
    }
  };
  if (detail.type === 'edit') {
    side(detail.oldString, 'del', '-');
    side(detail.newString, 'add', '+');
  } else {
    side(detail.content, 'add', '+');
  }
  return wrap;
}

// One DOM row per entry, kept across polls. Only rows whose entry changed are
// rebuilt (a tool call gaining its result, a pending message landing) and new
// ones appended; rebuilding all few-thousand rows on every change made the
// page lag.
const rows = [];
const sigs = [];

function buildRow(e, i) {

    const row = document.createElement('div');
    row.className = 'row ' + e.kind + (e.failed ? ' failed' : '') + (e.queued ? ' queued' : '') + (e.pending ? ' pending' : '');

    const t = document.createElement('span');
    t.className = 't';
    t.textContent = time(e.at);

    const tag = document.createElement('span');
    tag.className = 'tag ' + e.kind;
    // Queued messages arrived mid-turn; worth distinguishing at a glance.
    const who = e.kind !== 'incoming' ? '' : e.system ? 'system' : (e.thread || '').endsWith('@g.us') ? 'group' : 'adam';
    if (who) row.classList.add('from-' + who);
    tag.textContent = e.kind === 'incoming'
      ? (who + (e.queued && who === 'adam' ? '+' : ''))
      : e.kind === 'reply' ? (e.failed ? 'undeliv' : 'reply')
      : e.kind === 'tool' ? (e.failed ? 'error' : 'tool') : e.kind;
    if (e.queued) tag.title = 'sent while a turn was already running';
    if (e.pending) tag.title = 'delivered; the agent sees it when its current step finishes';
    if (e.kind === 'reply' && e.failed) tag.title = 'send failed — Adam did not get this';

    const body = document.createElement('span');
    body.className = 'body';
    const key = i + '/' + e.at + '/' + (e.name || e.kind);

    if (e.kind === 'tool') {
      const head = document.createElement('div');
      head.className = 'head';
      const name = document.createElement('b');
      name.textContent = e.name;
      head.append(name, ' ' + (e.input || ''));
      body.append(head);
      if (e.detail) {
        const d = document.createElement('details');
        const s = document.createElement('summary');
        s.textContent = e.detail.type === 'edit' ? 'diff'
          : e.detail.type === 'write' ? 'content (' + e.detail.content.split('\\n').length + ' lines)'
          : 'input';
        d.append(s);
        if (e.detail.type === 'json') {
          const pre = document.createElement('pre');
          pre.textContent = e.detail.json;
          d.append(pre);
        } else {
          d.append(diffBlock(e.detail));
        }
        keepOpen(d, key + '/in');
        body.append(d);
      }
      if (e.result) {
        const d = document.createElement('details');
        const lines = e.result.split('\\n').length;
        d.innerHTML = '<summary>output (' + lines + ' lines)</summary>';
        const pre = document.createElement('pre');
        pre.textContent = e.result;
        d.append(pre);
        keepOpen(d, key + '/out');
        body.append(d);
      } else {
        // No result yet: this is the call currently in flight.
        row.classList.add('running');
        const wait = document.createElement('span');
        wait.className = 'waiting';
        wait.textContent = '· running';
        body.append(wait);
      }
      // Screenshots read back, photos downloaded, files sent: shown as
      // pictures, loaded only once the row is expanded.
      for (const direction of ['in', 'out']) {
        const refs = (e.images || []).filter((r) => r.direction === direction);
        if (!refs.length) continue;
        const d = document.createElement('details');
        const s = document.createElement('summary');
        s.textContent = (direction === 'in' ? 'image sent' : 'image') + (refs.length > 1 ? 's (' + refs.length + ')' : '');
        const shots = document.createElement('div');
        shots.className = 'shots';
        for (const r of refs) {
          const a = document.createElement('a');
          a.href = '/api/image?id=' + encodeURIComponent(r.id);
          a.target = '_blank';
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.src = a.href;
          a.append(img);
          shots.append(a);
        }
        d.append(s, shots);
        keepOpen(d, key + '/img/' + direction);
        body.append(d);
      }
    } else if (e.kind === 'reply') {
      body.textContent = e.text;
      if (!e.result) {
        row.classList.add('running');
      } else if (e.failed) {
        const d = document.createElement('details');
        d.innerHTML = '<summary>send error</summary>';
        const pre = document.createElement('pre');
        pre.textContent = e.result;
        d.append(pre);
        keepOpen(d, key + '/err');
        body.append(d);
      }
    } else {
      linkify(body, e.text);
    }

    const bubbleLook = e.kind === 'incoming' || e.kind === 'reply';
    if (bubbleLook && e.system) {
      // Service chatter (restarts, scheduled runs, reply checks) becomes a
      // one-line divider with a short label; tap for the full text.
      const label = document.createElement('span');
      label.className = 'syslabel';
      label.textContent = systemLabel(e.text) + ' · ' + time(e.at);
      body.classList.add('sysfull');
      row.append(label, body);
      return row;
    }
    if (bubbleLook) {
      // Time sits inside the bubble, bottom-right, so it is obviously part of it.
      t.classList.add('inside');
      body.append(t);
      row.append(tag, body);
      return row;
    }

    row.append(t, tag, body);
    return row;
}

// Plain text with URLs turned into links; everything else stays text nodes.
function linkify(el, text) {
  const re = /https?:\\/\\/[^\\s<>()"'\\]]+[^\\s<>()"'\\].,;:!?]/g;
  let last = 0; let m;
  while ((m = re.exec(text))) {
    if (m.index > last) el.append(text.slice(last, m.index));
    const a = document.createElement('a');
    a.href = m[0]; a.textContent = m[0]; a.target = '_blank'; a.rel = 'noopener';
    el.append(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) el.append(text.slice(last));
}

function systemLabel(text) {
  const head = text.slice(0, 160);
  let m;
  if (/Self-restart completed/.test(head)) return 'restarted';
  if (/^This session is being continued from a previous conversation/.test(head)) return 'context compacted';
  if (/started at .* with no pending-restart marker/.test(head)) return 'unexpected start';
  if ((m = /\\[scheduled task: schedule:([^:\\]]+)/.exec(head))) return 'scheduled run · ' + m[1];
  if (/Reply check/.test(head)) return 'reply check';
  if (/^<task-notification>|background[- ]task|SYSTEM NOTIFICATION/i.test(head)) return 'background task finished';
  if ((m = /^<command-name>\\/?([^<]+)<\\/command-name>/.exec(head))) return 'command · ' + m[1];
  if (/^<local-command-caveat>/.test(head)) return 'command';
  if (/^<local-command-stdout>/.test(head)) return 'command output';
  if (/^<system-reminder>/.test(head)) return 'reminder';
  if (/hasn't heard from you/.test(head)) return 'nudge';
  return 'system';
}

const signature = (e) => JSON.stringify(e);

// Apply entries as the state from index from onwards; earlier rows are
// already correct.
function render(entries, from = 0) {
  latest = entries;
  if (!entries.length) {
    rows.length = 0;
    sigs.length = 0;
    root.innerHTML = '<div class="empty">nothing yet</div>';
    return;
  }
  if (rows.length === 0 || root.firstElementChild?.className === 'empty') root.replaceChildren();
  while (rows.length > entries.length) {
    rows.pop().remove();
    sigs.pop();
  }
  const frag = document.createDocumentFragment();
  for (let i = Math.min(from, rows.length); i < entries.length; i++) {
    const sig = signature(entries[i]);
    if (i < rows.length) {
      if (sigs[i] === sig) continue;
      const row = buildRow(entries[i], i);
      rows[i].replaceWith(row);
      rows[i] = row;
      sigs[i] = sig;
    } else {
      const row = buildRow(entries[i], i);
      rows.push(row);
      sigs.push(sig);
      frag.append(row);
    }
  }
  if (frag.childNodes.length) root.append(frag);
  groupRuns();
  syncTyping();
  reconcileOptimistic();
}

// The agent's work between two conversation messages into one
// "worked · n steps" line. Rows stay 1:1 with entries; the summaries are
// extra nodes recomputed after each render (cheap: only the summaries move).
const openRuns = new Set();
function groupRuns() {
  for (const el of root.querySelectorAll('.run')) el.remove();
  for (const r of rows) r.classList.remove('in-run', 'run-open');
  const isWork = (e) => e && (e.kind === 'tool' || e.kind === 'notes');
  let i = 0;
  while (i < latest.length) {
    if (!isWork(latest[i])) { i++; continue; }
    let j = i;
    while (j < latest.length && isWork(latest[j])) j++;
    const last = j === latest.length; // the run in progress stays open
    const open = last || openRuns.has(i);
    const tools = latest.slice(i, j).filter((e) => e.kind === 'tool').length;
    const ms = Date.parse(latest[j - 1].at) - Date.parse(latest[i].at);
    const dur = !isFinite(ms) || ms < 1000 ? '' : ms < 60000 ? Math.round(ms / 1000) + 's' : Math.round(ms / 60000) + 'm';
    const start = i;
    const sum = document.createElement('div');
    sum.className = 'run' + (open ? ' open' : '') + (last && state === 'working' ? ' live' : '');
    const verb = last && state === 'working' ? 'working' : (tools ? 'worked' : 'thought');
    sum.textContent = verb + (tools ? ' · ' + tools + (tools === 1 ? ' step' : ' steps') : '') + (dur ? ' · ' + dur : '');
    sum.addEventListener('click', () => {
      if (openRuns.has(start)) openRuns.delete(start); else openRuns.add(start);
      groupRuns();
    });
    rows[i].before(sum);
    for (let k = i; k < j; k++) { rows[k].classList.add('in-run'); if (open) rows[k].classList.add('run-open'); }
    i = j;
  }
}

// A typing-dots bubble at the end while a turn is running.
let typingEl = null;
function syncTyping() {
  const want = state === 'working' && latest.length > 0;
  if (want && !typingEl) {
    typingEl = document.createElement('div');
    typingEl.className = 'typing';
  }
  if (want) {
    // Doing (a tool call in flight) vs thinking (text being generated).
    const last = latest[latest.length - 1];
    const doing = last && last.kind === 'tool' && !last.result ? last.name : null;
    typingEl.className = 'typing' + (doing ? ' doing' : '');
    typingEl.innerHTML = '<span></span><span></span><span></span><span class="lbl">' + (doing ? 'running ' + doing.replace(/[<>&]/g, '') : 'thinking') + '</span>';
    root.append(typingEl);
  } else if (typingEl) { typingEl.remove(); }
}

// Body classes: state from the poll loop, composer from whether this viewer has one.
let state = 'idle';
function syncBodyClass() {
  document.body.className = 'st-' + state + (CHAT ? ' has-composer' : '');
}

function setState(next) {
  const changed = state !== next;
  state = next;
  syncBodyClass();
  if (changed) { groupRuns(); syncTyping(); }
}

let running = false; // the runner's own word, from /api/version
function computeState() {
  if (running) return 'working';
  const last = latest[latest.length - 1];
  const unresolved = last && (last.kind === 'tool' || last.kind === 'reply') && !last.result;
  // Fallback for older servers: a call in flight, or the transcript moved in the last 15s.
  if (unresolved || Date.now() - changedAt < 15000) return 'working';
  return 'idle';
}

// How far back to re-fetch: a result can back-fill a call a few entries
// up, and pending web messages sit at the very end.
const TAIL = 12;

async function refresh() {
  const from = Math.max(0, latest.length - TAIL);
  let r = await fetch('/api/entries?from=' + from);
  let data = await r.json();
  // The transcript shrank or moved (session rotation): start over.
  if (data.total < from || data.from !== from) {
    r = await fetch('/api/entries');
    data = await r.json();
  }
  const entries = data.from > 0 ? latest.slice(0, data.from).concat(data.entries) : data.entries;
  const wasAtBottom = atBottom();
  const grew = Math.max(0, entries.length - latest.length);
  render(entries, data.from);
  if (wasAtBottom) {
    window.scrollTo(0, document.body.scrollHeight);
  } else {
    unseenRows += grew;
  }

  syncJump();
  seen = data.version;
}

async function poll() {
  try {
    const r = await fetch('/api/version');
    const data = await r.json();
    if (data.changedAt) changedAt = data.changedAt;
    running = Boolean(data.running);
    if (data.version !== seen) await refresh();
    setState(computeState());
  } catch {
    setState('offline');
  }
  setTimeout(poll, 1000);
}

// Optimistic echoes of just-sent messages, one per send (a quick follow-up
// must not knock the previous one out before the transcript has it). Each is
// removed once the same text shows up as a real incoming entry; until then it
// carries a delivery state like a messaging app would.
const optimistic = [];
function showOptimistic(text) {
  const row = document.createElement('div');
  row.className = 'row incoming from-adam optimistic';
  const body = document.createElement('span');
  body.className = 'body';
  body.textContent = text;
  const st = document.createElement('span');
  st.className = 'delivery';
  st.textContent = 'sent';
  row.append(body, st);
  (typingEl && typingEl.parentNode ? typingEl : null)?.before(row) || root.append(row);
  optimistic.push({row, text, at: Date.now()});
  window.scrollTo(0, document.body.scrollHeight);
}
function reconcileOptimistic() {
  for (let i = optimistic.length - 1; i >= 0; i--) {
    const o = optimistic[i];
    const seen = latest.some((e) => e.kind === 'incoming' && e.text === o.text && !e.pending && Date.parse(e.at) >= o.at - 60000);
    if (seen) { o.row.remove(); optimistic.splice(i, 1); continue; }
    const pending = latest.some((e) => e.kind === 'incoming' && e.text === o.text && e.pending);
    o.row.querySelector('.delivery').textContent = pending ? 'delivered' : 'sent';
  }
}

if (CHAT) {
  const form = document.getElementById('composer');
  const box = document.getElementById('message');
  const button = document.getElementById('sendButton');
  const note = document.getElementById('composerNote');

  const grow = () => {
    box.style.height = 'auto';
    const max = Math.round(window.innerHeight * 0.3);
    box.style.height = Math.min(box.scrollHeight, max) + 'px';
    // No scrollbar until the text really overflows: an always-on gutter looked broken.
    box.style.overflowY = box.scrollHeight > max ? 'auto' : 'hidden';
    // Keep the thread readable above a tall box: pad the page by the box's height.
    document.documentElement.style.setProperty('--composer-h', form.offsetHeight + 'px');
  };
  window.addEventListener('resize', grow);
  grow();
  box.addEventListener('input', grow);
  // Enter sends, shift+enter is a newline — except on touch keyboards, where
  // there is no shift and the send button is right there.
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = box.value;
    if (!text.trim()) return;
    button.disabled = true;
    note.className = '';
    try {
      const r = await fetch('/api/message', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({text}),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
      box.value = '';
      grow();
      // Show the message at once, with a delivery state under it: "sent" now,
      // "seen" once the agent has picked it up (it then appears in the
      // transcript and the optimistic copy goes away).
      showOptimistic(text);
      refresh().catch(() => {});
    } catch (err) {
      note.className = 'err';
      note.textContent = 'not sent: ' + err.message;
    } finally {
      button.disabled = false;
      box.focus();
    }
  });
}

syncBodyClass();
refresh().then(() => window.scrollTo(0, document.body.scrollHeight));
poll();
// The page is for talking to the agent as much as watching it: start with
// the caret in the box.
if (CHAT) document.getElementById('message')?.focus();
</script>
</html>`;
}
