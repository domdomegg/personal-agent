/**
 * The viewer: every tool call a row, newest last, output expandable inline.
 * For watching a run happen, and for working out afterwards why it did
 * something odd.
 *
 * The kind filters double as the old conversation view — adam + reply alone is
 * the delivered conversation — which is why that second page was dropped.
 */
export function streamPage(): string {
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent · activity</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0c0e; --line: #1e2126; --text: #d6d9de; --dim: #767c86;
    --tool: #7aa2f7; --reply: #9ece6a; --in: #e0af68; --err: #f7768e;
    --add: #1d2b1d; --add-text: #b2dfae; --del: #2e1a1e; --del-text: #e8a7b0;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  header {
    position: sticky; top: 0; z-index: 2; background: rgba(11,12,14,.94);
    backdrop-filter: blur(8px); border-bottom: 1px solid var(--line);
    padding: 8px 14px; display: flex; align-items: center; gap: 12px;
  }
  header h1 { font-size: 13px; margin: 0; font-weight: 600; letter-spacing: .04em; }
  nav a { color: var(--dim); text-decoration: none; margin-right: 10px; }
  nav a:hover { color: var(--text); }
  .status { margin-left: auto; color: var(--dim); display: flex; align-items: center; gap: 8px; }

  /* Clawd: the official Claude Code pixel sprite (16x14, squares only),
     three states — working (paintbrush wave, the sprite's own two-frame
     animation), idle (eyes shut + zzz), offline (grey). No transforms:
     sub-pixel motion blurs pixel art, so state changes swap pixels instead. */
  #clawd { width: 31px; height: 26px; overflow: visible; }
  #clawd .eye-open, #clawd .eye-shut, #clawd .f1 { display: none; }
  #clawd .zzz { display: none; fill: var(--dim); font-size: 3.6px; }
  .st-working #clawd .eye-open { display: block; }
  .st-working #clawd .f0 { animation: wave0 .84s linear infinite; }
  .st-working #clawd .f1 { display: block; animation: wave1 .84s linear infinite; }
  .st-idle #clawd .eye-shut { display: block; }
  .st-idle #clawd .zzz { display: block; animation: floatz 3.4s ease-in-out infinite; }
  .st-offline #clawd { filter: grayscale(1); opacity: .45; }
  .st-offline #clawd .eye-shut { display: block; }
  @keyframes wave0 { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
  @keyframes wave1 { 0%, 49% { opacity: 0; } 50%, 100% { opacity: 1; } }
  @keyframes floatz { 0% { opacity: 0; transform: translateY(.8px); } 40% { opacity: 1; } 100% { opacity: 0; transform: translateY(-1.6px); } }

  /* Jump-to-latest: only shown when scrolled away from the bottom. */
  #jump {
    position: fixed; right: 16px; bottom: 20px; z-index: 3;
    background: #171a1f; color: var(--text); border: 1px solid #39404a;
    border-radius: 999px; padding: 8px 14px; font: inherit; cursor: pointer;
    box-shadow: 0 4px 16px rgba(0,0,0,.5); display: none; align-items: center; gap: 7px;
  }
  #jump.show { display: flex; }
  #jump .n { color: var(--reply); }
  main { padding: 4px 0 96px; }
  .row { display: flex; gap: 10px; padding: 3px 14px; align-items: baseline; }
  .row:hover { background: #101216; }
  .t { color: #4c525c; flex: none; }
  .tag { flex: none; width: 62px; }
  .tag.tool { color: var(--tool); } .tag.reply { color: var(--reply); }
  .tag.incoming { color: var(--in); } .tag.notes { color: var(--dim); }
  .row.failed .tag { color: var(--err); }
  .body { overflow-wrap: anywhere; white-space: pre-wrap; flex: 1; }
  .row.notes .body { color: var(--dim); }
  .row.running { background: #12180f; }
  .row.queued { background: #17140d; }
  .waiting { color: var(--reply); animation: blink 1.4s ease-in-out infinite; }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  .row.tool .body b { font-weight: 600; color: var(--text); }
  details > summary { cursor: pointer; list-style: none; color: var(--dim); }
  details > summary::-webkit-details-marker { display: none; }
  pre {
    margin: 6px 0 2px; padding: 8px 10px; background: #101318;
    border-left: 2px solid var(--line); overflow-x: auto; max-height: 340px;
    color: #aeb4bd; white-space: pre-wrap;
  }
  .diff { margin: 6px 0 2px; border-left: 2px solid var(--line); max-height: 340px; overflow: auto; }
  .diff .file { color: var(--dim); padding: 4px 10px; background: #101318; }
  .diff .ln { padding: 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .diff .del { background: var(--del); color: var(--del-text); }
  .diff .add { background: var(--add); color: var(--add-text); }
  .empty { color: var(--dim); text-align: center; padding: 48px 0; }
</style>
<header>
  <h1>AGENT</h1>
  <nav><a href="/connect">connect</a></nav>
  <span class="status">
    <!-- Clawd, measured off the official sticker art (run-length analysis of
         the pixel grid): 12x8 units — 8x6 body, eyes 1 in from each edge on
         the second row, arms 2 wide either side, four 1x2 legs in two pairs
         flush with the body edges. The sticker's front arm is part-raised to
         hold the heart, so resting mirrors the rear arm and the wave lifts
         high. Frames swap whole rectangles: pixel art blurs under transforms. -->
    <svg id="clawd" viewBox="0 0 12 10" shape-rendering="crispEdges" aria-hidden="true">
      <g fill="#d97757">
        <rect x="2" y="1" width="8" height="6"/><!-- body -->
        <rect x="10" y="3" width="2" height="2"/><!-- rear arm -->
        <rect x="2" y="7" width="1" height="2"/><rect x="4" y="7" width="1" height="2"/>
        <rect x="7" y="7" width="1" height="2"/><rect x="9" y="7" width="1" height="2"/>
        <rect class="f0" x="0" y="3" width="2" height="2"/><!-- arm, resting -->
        <rect class="f1" x="0" y="0" width="2" height="2"/><!-- arm, raised -->
      </g>
      <g class="eye-open" fill="#2a1f1b">
        <rect x="3" y="2" width="1" height="1"/><rect x="8" y="2" width="1" height="1"/>
      </g>
      <g class="eye-shut" fill="#2a1f1b">
        <rect x="3" y="2" width="2" height="1"/><rect x="7" y="2" width="2" height="1"/>
      </g>
      <text class="zzz" x="7" y="0">z</text><text class="zzz" x="9" y="-1.4" style="animation-delay:1.1s;font-size:2.8px">z</text>
    </svg>
    <span id="status">…</span>
  </span>
</header>
<main id="root"><div class="empty">loading…</div></main>
<button id="jump">↓ latest<span class="n" id="jumpCount"></span></button>
<script>
const root = document.getElementById('root');
const statusEl = document.getElementById('status');
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

function render(entries) {
  latest = entries;
  if (!entries.length) { root.innerHTML = '<div class="empty">nothing yet</div>'; return; }
  const frag = document.createDocumentFragment();

  entries.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'row ' + e.kind + (e.failed ? ' failed' : '') + (e.queued ? ' queued' : '');

    const t = document.createElement('span');
    t.className = 't';
    t.textContent = time(e.at);

    const tag = document.createElement('span');
    tag.className = 'tag ' + e.kind;
    // Queued messages arrived mid-turn; worth distinguishing at a glance.
    tag.textContent = e.kind === 'incoming'
      ? (e.queued ? 'adam+' : 'adam')
      : e.kind === 'reply' ? (e.failed ? 'undeliv' : 'reply')
      : e.kind === 'tool' ? (e.failed ? 'error' : 'tool') : e.kind;
    if (e.queued) tag.title = 'sent while a turn was already running';
    if (e.kind === 'reply' && e.failed) tag.title = 'send failed — Adam did not get this';

    const body = document.createElement('span');
    body.className = 'body';
    const key = i + '/' + e.at + '/' + (e.name || e.kind);

    if (e.kind === 'tool') {
      const head = document.createElement('div');
      const name = document.createElement('b');
      name.textContent = e.name;
      head.append(name, ' ' + (e.input || ''));
      body.append(head);
      if (e.detail) {
        const d = document.createElement('details');
        const s = document.createElement('summary');
        s.textContent = e.detail.type === 'edit' ? '▸ diff'
          : e.detail.type === 'write' ? '▸ content (' + e.detail.content.split('\\n').length + ' lines)'
          : '▸ input';
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
        d.innerHTML = '<summary>▸ output (' + lines + ' lines)</summary>';
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
    } else if (e.kind === 'reply') {
      body.textContent = e.text;
      if (!e.result) {
        row.classList.add('running');
      } else if (e.failed) {
        const d = document.createElement('details');
        d.innerHTML = '<summary>▸ send error</summary>';
        const pre = document.createElement('pre');
        pre.textContent = e.result;
        d.append(pre);
        keepOpen(d, key + '/err');
        body.append(d);
      }
    } else {
      body.textContent = e.text;
    }

    row.append(t, tag, body);
    frag.append(row);
  });

  root.replaceChildren(frag);
}

function setState(state) {
  document.body.className = 'st-' + state;
  statusEl.textContent = state;
}

function computeState() {
  const last = latest[latest.length - 1];
  const unresolved = last && (last.kind === 'tool' || last.kind === 'reply') && !last.result;
  // Working = a call is in flight, or the transcript moved in the last 15s.
  if (unresolved || Date.now() - changedAt < 15000) return 'working';
  return 'idle';
}

async function refresh() {
  const r = await fetch('/api/entries');
  const data = await r.json();
  const wasAtBottom = atBottom();
  const grew = Math.max(0, data.entries.length - latest.length);
  render(data.entries);
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
    if (data.version !== seen) await refresh();
    setState(computeState());
  } catch {
    setState('offline');
  }
  setTimeout(poll, 1000);
}

refresh().then(() => window.scrollTo(0, document.body.scrollHeight));
poll();
</script>
</html>`;
}
