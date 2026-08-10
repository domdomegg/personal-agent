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
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  header {
    position: sticky; top: 0; z-index: 2; background: rgba(11,12,14,.94);
    backdrop-filter: blur(8px); border-bottom: 1px solid var(--line);
    padding: 10px 14px; display: flex; align-items: center; gap: 12px;
  }
  header h1 { font-size: 13px; margin: 0; font-weight: 600; letter-spacing: .04em; }
  nav a { color: var(--dim); text-decoration: none; }
  nav a.on { color: var(--tool); }
  .live { margin-left: auto; color: var(--dim); display: flex; align-items: center; gap: 6px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #5ac467; }
  .dot.idle { background: var(--dim); }
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
  .empty { color: var(--dim); text-align: center; padding: 48px 0; }
</style>
<header>
  <h1>AGENT</h1>
  <span class="live"><span class="dot" id="dot"></span><span id="status">live</span></span>
</header>
<main id="root"><div class="empty">loading…</div></main>
<button id="jump">↓ latest<span class="n" id="jumpCount"></span></button>
<script>
const root = document.getElementById('root');
const statusEl = document.getElementById('status');
const dot = document.getElementById('dot');
const jump = document.getElementById('jump');
const jumpCount = document.getElementById('jumpCount');
const opened = new Set();
let latest = [];
let seen = -1;
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

function render(entries) {
  latest = entries;
  if (!entries.length) { root.innerHTML = '<div class="empty">nothing yet</div>'; return; }
  const frag = document.createDocumentFragment();

  for (const e of entries) {
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
      : e.kind === 'tool' ? (e.failed ? 'error' : 'tool') : e.kind;
    if (e.queued) tag.title = 'sent while a turn was already running';

    const body = document.createElement('span');
    body.className = 'body';

    if (e.kind === 'tool') {
      const head = document.createElement('div');
      const name = document.createElement('b');
      name.textContent = e.name;
      head.append(name, ' ' + (e.input || ''));
      body.append(head);
      if (e.result) {
        const d = document.createElement('details');
        const lines = e.result.split('\\n').length;
        d.innerHTML = '<summary>▸ output (' + lines + ' lines)</summary>';
        const pre = document.createElement('pre');
        pre.textContent = e.result;
        d.append(pre);
        // Keep it open across the once-a-second re-render.
        const key = e.at + '/' + e.name;
        d.open = opened.has(key);
        d.addEventListener('toggle', () => {
          if (d.open) opened.add(key); else opened.delete(key);
        });
        body.append(d);
      } else {
        // No result yet: this is the call currently in flight.
        row.classList.add('running');
        const wait = document.createElement('span');
        wait.className = 'waiting';
        wait.textContent = '· running';
        body.append(wait);
      }
    } else {
      body.textContent = e.text;
    }

    row.append(t, tag, body);
    frag.append(row);
  }

  root.replaceChildren(frag);
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
    const {version} = await r.json();
    if (version !== seen) await refresh();
    dot.className = 'dot';
    statusEl.textContent = 'live';
  } catch {
    dot.className = 'dot idle';
    statusEl.textContent = 'offline';
  }
  setTimeout(poll, 1000);
}

refresh().then(() => window.scrollTo(0, document.body.scrollHeight));
poll();
</script>
</html>`;
}
