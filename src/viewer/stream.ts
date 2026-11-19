/**
 * The viewer: every tool call a row, newest last, output expandable inline.
 * For watching a run happen, and for working out afterwards why it did
 * something odd.
 *
 * The kind filters double as the old conversation view — adam + reply alone is
 * the delivered conversation — which is why that second page was dropped.
 *
 * With `chat`, a message box sits at the bottom: what is typed there reaches
 * the agent as a web-channel event, and its replies show up as reply rows like
 * any other. The "chat" view hides the working-out so the conversation reads
 * on its own.
 */
const COMPOSER = `<span id="composerNote"></span>
<form id="composer">
  <textarea id="message" rows="1" placeholder="message the agent" aria-label="message the agent"></textarea>
  <button type="submit" id="sendButton">send</button>
</form>`;

export function streamPage(options: {chat?: boolean} = {}): string {
	const chat = options.chat ?? false;
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
  nav a { color: var(--dim); text-decoration: none; margin-right: 10px; padding-bottom: 2px; }
  nav a:hover { color: var(--text); }
  nav a.active { color: var(--text); border-bottom: 1px solid var(--text); }
  .status { margin-left: auto; color: var(--dim); display: flex; align-items: center; gap: 8px; }

  /* Clawd: the official Claude Code pixel sprite (16x14, squares only),
     three states — working (paintbrush wave, the sprite's own two-frame
     animation), idle (eyes shut + zzz), offline (grey). No transforms:
     sub-pixel motion blurs pixel art, so state changes swap pixels instead. */
  #clawd { width: 31px; height: 26px; overflow: visible; }
  #clawd .eye-open, #clawd .eye-shut, #clawd .f0, #clawd .f1 { display: none; }
  #clawd .zzz { display: none; fill: var(--dim); font-size: 3.6px; }
  .st-working #clawd .eye-open { display: block; }
  .st-working #clawd .legs { display: none; }
  .st-working #clawd .f0 { display: block; animation: wave0 .84s linear infinite; }
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
  .row.pending { opacity: .6; }
  .row.pending .tag::after { content: ' ⏳'; }
  .waiting { color: var(--reply); animation: blink 1.4s ease-in-out infinite; }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  .row.tool .body b { font-weight: 600; color: var(--text); }
  details > summary { cursor: pointer; list-style: none; color: var(--dim); }
  details > summary::-webkit-details-marker { display: none; }
  details > summary::before { content: '▸ '; }
  details[open] > summary::before { content: '▾ '; }
  .shots { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 2px; }
  .shots img { max-width: min(100%, 720px); max-height: 420px; border: 1px solid var(--line); border-radius: 3px; background: #101318; }
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

  /* Chat view: only the conversation. */
  .chat-only .row.tool, .chat-only .row.notes { display: none; }

  /* Message box, pinned to the bottom. */
  .has-composer main { padding-bottom: 140px; }
  .has-composer #jump { bottom: 96px; }
  #composer {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 2;
    background: rgba(11,12,14,.96); border-top: 1px solid var(--line);
    padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
    display: flex; gap: 8px; align-items: flex-end;
  }
  #composer textarea {
    flex: 1; min-width: 0; resize: none; max-height: 40vh;
    background: #101318; color: var(--text); border: 1px solid #39404a; border-radius: 6px;
    padding: 8px 10px; font: inherit; font-size: 16px; /* 16px stops iOS zooming on focus */
  }
  #composer textarea:focus { outline: none; border-color: var(--in); }
  #composer button {
    flex: none; background: #1f2a1a; color: var(--reply); border: 1px solid #3a4f2e;
    border-radius: 6px; padding: 8px 14px; font: inherit; cursor: pointer;
  }
  #composer button:disabled { opacity: .5; cursor: default; }
  #composerNote { position: fixed; left: 14px; bottom: 64px; z-index: 2; color: var(--dim); font-size: 12px; }
  #composerNote.err { color: var(--err); }

  /* ---- cross-cutting polish (all looks) ---- */
  header { gap: 10px; }
  nav { display: flex; gap: 2px; white-space: nowrap; overflow-x: auto; scrollbar-width: none; }
  nav a { margin: 0; padding: 4px 8px; border-radius: 6px; }
  nav a.active { border-bottom: 0; background: #1a1d23; }
  #uiPick { display: flex; gap: 2px; margin-left: 4px; }
  #uiPick a { color: #4c525c; text-decoration: none; font-size: 11px; padding: 3px 6px; border-radius: 5px; }
  #uiPick a.active { color: var(--text); background: #1a1d23; }
  .row.tool .head { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; }
  .row.tool.open .head { display: block; }
  @media (max-width: 640px) {
    header { padding: 6px 10px; }
    header h1 { display: none; }
    nav { flex: 1; min-width: 0; }
    nav a[href="/connect"] { display: none; }
    #uiPick a[data-ui="classic"] { display: none; }
    .status { flex: none; }
    .status { font-size: 12px; }
    .row { display: grid; grid-template-columns: 1fr; gap: 0; padding: 6px 10px; }
    .row .t { font-size: 11px; }
    .row .tag { width: auto; font-size: 11px; }
    .row .t, .row .tag { display: inline; }
    .row .body { grid-column: 1 / -1; }
    .row .t::after { content: ' · '; color: #3a3f47; }
    .row .t, .row .tag { grid-row: 1; }
    .row { grid-template-columns: auto auto 1fr; }
    .row .tag { grid-column: 2 / -1; }
  }

  /* ---- look A: chat-first (claude.ai / iMessage) ---- */
  [data-ui="a"] body { font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  [data-ui="a"] main { max-width: 820px; margin: 0 auto; padding: 10px 0 150px; }
  [data-ui="a"] .row.incoming, [data-ui="a"] .row.reply { display: flex; flex-direction: column; padding: 6px 14px; }
  [data-ui="a"] .row.incoming { align-items: flex-end; }
  [data-ui="a"] .row.reply { align-items: flex-start; }
  [data-ui="a"] .row.incoming .t, [data-ui="a"] .row.reply .t { order: 3; font-size: 11px; margin-top: 3px; color: #4c525c; }
  [data-ui="a"] .row.incoming .tag, [data-ui="a"] .row.reply .tag { display: none; }
  [data-ui="a"] .row.incoming .body, [data-ui="a"] .row.reply .body {
    max-width: min(78%, 620px); padding: 9px 13px; border-radius: 16px; flex: none; font-size: 15px; line-height: 1.45;
  }
  [data-ui="a"] .row.incoming .body { border-bottom-right-radius: 5px; }
  [data-ui="a"] .row.reply .body { border-bottom-left-radius: 5px; }
  [data-ui="a"] .row.reply.failed .body { outline: 1px solid var(--err); }
  [data-ui="a"] .row.incoming:hover, [data-ui="a"] .row.reply:hover { background: transparent; }
  [data-ui="a"] .row.tool, [data-ui="a"] .row.notes {
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 1px 14px 1px 24px; color: var(--dim);
    border-left: 2px solid #1e2126; margin-left: 14px;
  }
  [data-ui="a"] .row.tool .t, [data-ui="a"] .row.notes .t { display: none; }
  [data-ui="a"] .row.tool .tag { width: 38px; font-size: 11px; }
  [data-ui="a"] .row.tool .head { -webkit-line-clamp: 1; }
  [data-ui="a"] .row.tool .body b { color: #9aa3b2; }
  [data-ui="a"] .row.notes .body { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  [data-ui="a"] #composer { background: rgba(11,12,14,.9); border-top: 0; }
  [data-ui="a"] #composer textarea { border-radius: 20px; padding: 10px 16px; background: #15181e; border-color: #2a2f38; }
  [data-ui="a"] #composer button { border-radius: 20px; padding: 10px 16px; border: 0; font-weight: 600; }
  @media (max-width: 640px) {
    [data-ui="a"] .row.incoming .body, [data-ui="a"] .row.reply .body { max-width: 88%; }
    [data-ui="a"] .row.incoming .t, [data-ui="a"] .row.reply .t { grid-row: auto; }
    [data-ui="a"] .row.incoming, [data-ui="a"] .row.reply { display: flex; }
  }

  /* ---- look B: refined console (Warp / Linear) ---- */
  [data-ui="b"] body { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  [data-ui="b"] header, [data-ui="b"] nav a, [data-ui="b"] .status, [data-ui="b"] .tag, [data-ui="b"] #composer button {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  [data-ui="b"] header h1 { letter-spacing: .12em; font-size: 11px; color: var(--dim); }
  [data-ui="b"] main { padding-top: 8px; }
  [data-ui="b"] .row { padding: 2px 16px 2px 12px; gap: 12px; border-left: 2px solid transparent; }
  [data-ui="b"] .row .t { font-size: 11px; opacity: .7; }
  [data-ui="b"] .tag { width: 56px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; padding-top: 1px; }
  [data-ui="b"] .row.tool { border-left-color: #202a3d; color: #9aa3b2; }
  [data-ui="b"] .row.tool + .row.tool { margin-top: -1px; }
  [data-ui="b"] .row.tool .head { -webkit-line-clamp: 1; }
  [data-ui="b"] .row.tool .body b { color: #c3cbd6; }
  [data-ui="b"] .row.notes { border-left-color: #1e2126; }
  [data-ui="b"] .row.notes .body { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  [data-ui="b"] .row.notes.open .body { display: block; }
  [data-ui="b"] .row.incoming, [data-ui="b"] .row.reply {
    margin: 8px 10px; padding: 10px 12px; border-radius: 8px; border-left: 2px solid;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  [data-ui="b"] .row.incoming { background: #15130d; border-left-color: var(--in); }
  [data-ui="b"] .row.reply { background: #10150f; border-left-color: var(--reply); }
  [data-ui="b"] .row.incoming .t, [data-ui="b"] .row.reply .t { font-family: ui-monospace, Menlo, monospace; }
  [data-ui="b"] pre, [data-ui="b"] .diff { border-radius: 6px; border-left: 0; background: #0e1116; }
  [data-ui="b"] #composer textarea { border-radius: 8px; }

  /* ---- look C: paper (Notion / Things) ---- */
  [data-ui="c"] {
    color-scheme: light;
    --bg: #faf8f3; --line: #e6e1d6; --text: #27241d; --dim: #8a8477;
    --tool: #3b6fb6; --reply: #2f7d4a; --in: #a4601a; --err: #b8323a;
    --add: #e3f2e3; --add-text: #1e5a2a; --del: #f8e1e1; --del-text: #7a1f26;
  }
  [data-ui="c"] body { font: 16px/1.55 Georgia, "Iowan Old Style", "Palatino Linotype", serif; color: var(--text); background: var(--bg); }
  [data-ui="c"] header { background: rgba(250,248,243,.94); border-bottom-color: var(--line); }
  [data-ui="c"] header h1 { font-family: Georgia, serif; font-weight: 600; letter-spacing: .02em; font-size: 15px; }
  [data-ui="c"] nav a, [data-ui="c"] #uiPick a, [data-ui="c"] .status, [data-ui="c"] .tag, [data-ui="c"] .t, [data-ui="c"] #composer button {
    font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  [data-ui="c"] nav a.active, [data-ui="c"] #uiPick a.active { background: #ece7db; }
  [data-ui="c"] main { max-width: 760px; margin: 0 auto; padding: 14px 0 150px; }
  [data-ui="c"] .row:hover { background: transparent; }
  [data-ui="c"] .row.incoming, [data-ui="c"] .row.reply {
    display: block; margin: 10px 14px; padding: 14px 18px; background: #fff; border: 1px solid var(--line);
    border-radius: 12px; box-shadow: 0 1px 2px rgba(60,50,30,.06);
  }
  [data-ui="c"] .row.incoming { background: #fff8ec; }
  [data-ui="c"] .row.incoming .t, [data-ui="c"] .row.reply .t, [data-ui="c"] .row.incoming .tag, [data-ui="c"] .row.reply .tag {
    display: inline; color: var(--dim); font-size: 12px; width: auto; margin-right: 8px;
  }
  [data-ui="c"] .row.incoming .body, [data-ui="c"] .row.reply .body { display: block; margin-top: 4px; }
  [data-ui="c"] .row.tool, [data-ui="c"] .row.notes {
    font: 12px/1.45 ui-monospace, Menlo, monospace; color: var(--dim); padding: 2px 14px 2px 32px;
  }
  [data-ui="c"] .row.tool .t { color: #b5afa2; }
  [data-ui="c"] .row.tool .body b { color: #5b5648; }
  [data-ui="c"] .row.tool .head { -webkit-line-clamp: 1; }
  [data-ui="c"] pre, [data-ui="c"] .diff .file { background: #f1ede4; color: #3d3a32; border-color: var(--line); }
  [data-ui="c"] .diff { border-color: var(--line); }
  [data-ui="c"] #jump { background: #fff; color: var(--text); border-color: var(--line); box-shadow: 0 4px 16px rgba(60,50,30,.15); }
  [data-ui="c"] #composer { background: rgba(250,248,243,.96); border-top-color: var(--line); }
  [data-ui="c"] #composer textarea { background: #fff; color: var(--text); border-color: #d9d3c6; border-radius: 12px; font-family: Georgia, serif; }
  [data-ui="c"] #composer button { background: #27241d; color: #faf8f3; border: 0; border-radius: 12px; }
  [data-ui="c"] #composerNote { color: var(--dim); }
  [data-ui="c"] .row.running { background: #eef5e8; }
  [data-ui="c"] .row.queued { background: #f7efdd; }

  /* ---- look a: palette + conversation furniture ---- */
  [data-ui="a"] {
    --bg: #101113; --line: #22242a; --text: #e6e8ec; --dim: #8b9099;
    --me: #2f4f7f; --me-text: #eef3fb; --them: #1c1e23; --accent: #4f8cff;
  }
  @media (prefers-color-scheme: light) {
    [data-ui="a"] {
      color-scheme: light;
      --bg: #f6f7f9; --line: #e3e5ea; --text: #1b1d22; --dim: #6f7580;
      --me: #2f6fde; --me-text: #ffffff; --them: #ffffff; --accent: #2f6fde;
    }
    [data-ui="a"] header { background: rgba(246,247,249,.92); }
    [data-ui="a"] nav a.active, [data-ui="a"] #uiPick a.active { background: #e6e8ee; }
    [data-ui="a"] .row.reply .body { box-shadow: 0 1px 2px rgba(0,0,0,.06); }
    [data-ui="a"] #composer { background: rgba(246,247,249,.92); }
    [data-ui="a"] #composer textarea { background: #fff; border-color: #d9dce3; color: var(--text); }
    [data-ui="a"] .row.tool, [data-ui="a"] .row.notes { border-left-color: #e3e5ea; }
    [data-ui="a"] pre, [data-ui="a"] .diff .file { background: #eef0f4; color: #30343b; }
    [data-ui="a"] #jump { background: #fff; color: var(--text); border-color: var(--line); }
  }
  [data-ui="a"] body { background: var(--bg); color: var(--text); }
  [data-ui="a"] header { background: rgba(16,17,19,.9); border-bottom-color: var(--line); }
  [data-ui="a"] .row.incoming .body { background: var(--me); color: var(--me-text); }
  [data-ui="a"] .row.reply .body { background: var(--them); }
  [data-ui="a"] .row.incoming .body a, [data-ui="a"] .row.incoming .body { overflow-wrap: anywhere; }
  [data-ui="a"] .row.from-group .body { background: #1f3a3a; color: #e6f3f1; }
  [data-ui="a"] .row.from-group::before { content: 'group'; order: -1; font-size: 11px; color: var(--dim); margin: 0 4px 2px; }
  [data-ui="a"] .row.from-system { align-items: center; padding: 10px 14px; }
  [data-ui="a"] .row.from-system .body {
    max-width: 90%; background: transparent; color: var(--dim); font-size: 12px; text-align: center; padding: 0;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  [data-ui="a"] .row.from-system.open .body { display: block; }
  [data-ui="a"] .row.from-system .t { display: none; }
  [data-ui="a"] .row.pending { display: none; }               /* the optimistic echo stands in */
  [data-ui="a"] .row.optimistic { display: flex; opacity: 1; }
  [data-ui="a"] .delivery { font-size: 11px; color: var(--dim); margin: 3px 6px 0; }
  [data-ui="a"] .run {
    margin: 2px 14px 2px 22px; padding: 2px 8px; color: var(--dim); font-size: 12px; cursor: pointer; user-select: none;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; border-radius: 6px; width: fit-content;
  }
  [data-ui="a"] .run::before { content: '▸ '; }
  [data-ui="a"] .run.open::before { content: '▾ '; }
  [data-ui="a"] .run:hover { background: var(--them); }
  [data-ui="a"] .run.live { color: var(--accent); }
  [data-ui="a"] .row.in-run { display: none; }
  [data-ui="a"] .row.in-run.run-open { display: flex; }
  [data-ui="a"] .row.tool, [data-ui="a"] .row.notes { border-left-color: var(--line); }
  [data-ui="a"] .typing { display: flex; gap: 4px; align-items: center; margin: 6px 14px 10px; padding: 12px 14px; background: var(--them); border-radius: 16px; border-bottom-left-radius: 5px; width: fit-content; }
  [data-ui="a"] .typing span { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); animation: tdot 1.2s ease-in-out infinite; }
  [data-ui="a"] .typing span:nth-child(2) { animation-delay: .2s; }
  [data-ui="a"] .typing span:nth-child(3) { animation-delay: .4s; }
  @keyframes tdot { 0%, 60%, 100% { opacity: .3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
  [data-ui="a"] #clawd { display: none; }
  [data-ui="a"] .status { font: 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  [data-ui="a"] .status::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--dim); display: inline-block; }
  [data-ui="a"] .st-working .status::before { background: var(--accent); animation: blink 1.4s ease-in-out infinite; }
  [data-ui="a"] .st-offline .status::before { background: var(--err); }
  [data-ui="a"] #composer textarea { background: var(--them); border-color: var(--line); color: var(--text); font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  [data-ui="a"] #composer textarea:focus { border-color: var(--accent); }
  [data-ui="a"] #composer button { background: var(--accent); color: #fff; }
  [data-ui="a"] #composerNote { font-family: system-ui, -apple-system, sans-serif; }
  [data-ui="a"] .row.reply.failed .body::after { content: ' · not delivered'; color: var(--err); font-size: 12px; }
  [data-ui="a"] .chat-only .run { display: none; }

  /* look a: no row tints behind bubbles; chat view hides work even mid-run; no meta dot */
  [data-ui="a"] .row.queued, [data-ui="a"] .row.running, [data-ui="a"] .row:hover { background: transparent; }
  [data-ui="a"] .row.tool.running { background: var(--them); }
  [data-ui="a"] .chat-only .row.in-run.run-open, [data-ui="a"] .chat-only .typing ~ .run { display: none; }
  [data-ui="a"] .chat-only .row.tool, [data-ui="a"] .chat-only .row.notes { display: none; }
  @media (max-width: 640px) { [data-ui="a"] .row .t::after { content: none; } }

  /* look a: system dividers + in-bubble timestamps */
  [data-ui="a"] .row.from-system { display: flex; flex-direction: column; align-items: center; padding: 4px 14px; cursor: pointer; }
  [data-ui="a"] .row.from-system .tag { display: none; }
  [data-ui="a"] .row.from-system .syslabel {
    font: 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--dim); letter-spacing: .02em;
    padding: 2px 10px; border-radius: 999px; background: var(--them); opacity: .8;
  }
  [data-ui="a"] .row.from-system .sysfull { display: none; max-width: 90%; margin-top: 6px; font-size: 12px; color: var(--dim); text-align: left; white-space: pre-wrap; background: transparent; padding: 0; -webkit-line-clamp: unset; }
  [data-ui="a"] .row.from-system.open .sysfull { display: block; }
  [data-ui="a"] .chat-only .row.from-system { display: none; }
  [data-ui="a"] .t.inside { float: right; margin: 6px 0 0 10px; font-size: 10.5px; line-height: 1; opacity: .65; position: relative; top: 4px; font-family: system-ui, -apple-system, sans-serif; }
  [data-ui="a"] .row.incoming .t.inside { color: var(--me-text); }
  [data-ui="a"] .row.reply .t.inside { color: var(--dim); }
  [data-ui="a"] .row.incoming .body, [data-ui="a"] .row.reply .body { padding-right: 12px; }
  [data-ui="a"] .delivery { margin-top: 2px; }
</style>
<header>
  <h1>AGENT</h1>
  <nav><a id="navActivity" class="active" href="/">activity</a>${chat ? ' <a id="navChat" href="/#chat">chat</a>' : ''} <a href="/desktop" target="_blank">desktop</a> <a href="/connect">connect</a></nav>
  <span id="uiPick" title="try a different look"><a href="?ui=classic" data-ui="classic">classic</a><a href="?ui=a" data-ui="a">a</a><a href="?ui=b" data-ui="b">b</a><a href="?ui=c" data-ui="c">c</a></span>
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
        <rect x="0" y="3" width="2" height="2"/><!-- front arm -->
        <rect x="10" y="3" width="2" height="2"/><!-- rear arm -->
        <!-- Working = a little scuttle: diagonal leg pairs lift alternately.
             Idle and offline show all four legs planted. -->
        <g class="legs">
          <rect x="2" y="7" width="1" height="2"/><rect x="4" y="7" width="1" height="2"/>
          <rect x="7" y="7" width="1" height="2"/><rect x="9" y="7" width="1" height="2"/>
        </g>
        <g class="f0">
          <rect x="2" y="7" width="1" height="1"/><rect x="4" y="7" width="1" height="2"/>
          <rect x="7" y="7" width="1" height="2"/><rect x="9" y="7" width="1" height="1"/>
        </g>
        <g class="f1">
          <rect x="2" y="7" width="1" height="2"/><rect x="4" y="7" width="1" height="1"/>
          <rect x="7" y="7" width="1" height="1"/><rect x="9" y="7" width="1" height="2"/>
        </g>
      </g>
      <g class="eye-open" fill="#2a1f1b">
        <rect x="3" y="2" width="1" height="1"/><rect x="8" y="2" width="1" height="1"/>
      </g>
      <g class="eye-shut" fill="#2a1f1b"><!-- thin lids, low in the socket -->
        <rect x="3" y="2.5" width="2" height=".5"/><rect x="7" y="2.5" width="2" height=".5"/>
      </g>
      <text class="zzz" x="7" y="0">z</text><text class="zzz" x="9" y="-1.4" style="animation-delay:1.1s;font-size:2.8px">z</text>
    </svg>
    <span id="status">…</span>
  </span>
</header>
<main id="root"><div class="empty">loading…</div></main>
<button id="jump">↓ latest<span class="n" id="jumpCount"></span></button>
${chat ? COMPOSER : ''}
<script>
const CHAT = ${chat ? 'true' : 'false'};
// Look variants, for comparing side by side: ?ui=a|b|c|classic sticks per
// device (localStorage) so a phone and a laptop can run different ones.
(() => {
  const q = new URLSearchParams(location.search).get('ui');
  if (q) { localStorage.setItem('ui', q); history.replaceState(null, '', location.pathname + location.hash); }
  const ui = localStorage.getItem('ui') || 'a';
  document.documentElement.dataset.ui = ui;
  for (const a of document.querySelectorAll('#uiPick a')) a.classList.toggle('active', a.dataset.ui === ui);
})();
// Long tool commands are clamped; tap the head to see the whole thing.
document.addEventListener('click', (ev) => {
  const head = ev.target.closest('.row.tool .head, .row.notes .body, .row.from-system');
  if (head) head.closest('.row').classList.toggle('open');
});
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
      body.textContent = e.text;
    }

    const bubbleLook = document.documentElement.dataset.ui === 'a' && (e.kind === 'incoming' || e.kind === 'reply');
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

function systemLabel(text) {
  const head = text.slice(0, 160);
  let m;
  if (/Self-restart completed/.test(head)) return 'restarted';
  if (/started at .* with no pending-restart marker/.test(head)) return 'unexpected start';
  if ((m = /\[scheduled task: schedule:([^:\]]+)/.exec(head))) return 'scheduled run · ' + m[1];
  if (/Reply check/.test(head)) return 'reply check';
  if (/background[- ]task|SYSTEM NOTIFICATION/i.test(head)) return 'background task finished';
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

// Look a folds the agent's work between two conversation messages into one
// "worked · n steps" line. Rows stay 1:1 with entries; the summaries are
// extra nodes recomputed after each render (cheap: only the summaries move).
const openRuns = new Set();
function groupRuns() {
  for (const el of root.querySelectorAll('.run')) el.remove();
  for (const r of rows) r.classList.remove('in-run', 'run-open');
  if (document.documentElement.dataset.ui !== 'a') return;
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

// A typing-dots bubble at the end while a turn is running (look a).
let typingEl = null;
function syncTyping() {
  const want = document.documentElement.dataset.ui === 'a' && state === 'working' && latest.length > 0;
  if (want && !typingEl) {
    typingEl = document.createElement('div');
    typingEl.className = 'typing';
    typingEl.innerHTML = '<span></span><span></span><span></span>';
  }
  if (want) root.append(typingEl); else if (typingEl) { typingEl.remove(); }
}

// Body classes: state from the poll loop, view from the URL hash, composer
// from whether this viewer has one. Rebuilt whole so none clobbers another.
let state = 'idle';
function syncBodyClass() {
  const chatView = CHAT && location.hash === '#chat';
  document.body.className = 'st-' + state + (chatView ? ' chat-only' : '') + (CHAT ? ' has-composer' : '');
  const nav = document.getElementById('navChat');
  if (nav) {
    nav.classList.toggle('active', chatView);
    document.getElementById('navActivity').classList.toggle('active', !chatView);
  }
  // Arriving on the chat view is for typing: put the caret in the box.
  if (chatView) document.getElementById('message')?.focus();
}
window.addEventListener('hashchange', () => { syncBodyClass(); window.scrollTo(0, document.body.scrollHeight); });

function setState(next) {
  const changed = state !== next;
  state = next;
  syncBodyClass();
  statusEl.textContent = next;
  if (changed) { groupRuns(); syncTyping(); }
}

function computeState() {
  const last = latest[latest.length - 1];
  const unresolved = last && (last.kind === 'tool' || last.kind === 'reply') && !last.result;
  // Working = a call is in flight, or the transcript moved in the last 15s.
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
    if (data.version !== seen) await refresh();
    setState(computeState());
  } catch {
    setState('offline');
  }
  setTimeout(poll, 1000);
}

// Optimistic echo of a just-sent message. Removed once the same text shows
// up as a real incoming entry (the agent has it); until then it carries a
// delivery state like a messaging app would.
let optimistic = null;
function showOptimistic(text) {
  clearOptimistic();
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
  optimistic = {row, text, at: Date.now()};
  window.scrollTo(0, document.body.scrollHeight);
}
function clearOptimistic() { if (optimistic) { optimistic.row.remove(); optimistic = null; } }
function reconcileOptimistic() {
  if (!optimistic) return;
  const seen = latest.some((e) => e.kind === 'incoming' && e.text === optimistic.text && !e.pending && Date.parse(e.at) >= optimistic.at - 60000);
  if (seen) { clearOptimistic(); return; }
  const pending = latest.some((e) => e.kind === 'incoming' && e.text === optimistic.text && e.pending);
  optimistic.row.querySelector('.delivery').textContent = pending ? 'delivered' : 'sent';
}

if (CHAT) {
  const form = document.getElementById('composer');
  const box = document.getElementById('message');
  const button = document.getElementById('sendButton');
  const note = document.getElementById('composerNote');

  const grow = () => {
    box.style.height = 'auto';
    const max = Math.round(window.innerHeight * 0.4);
    box.style.height = Math.min(box.scrollHeight, max) + 'px';
    // No scrollbar until the text really overflows: an always-on gutter looked broken.
    box.style.overflowY = box.scrollHeight > max ? 'auto' : 'hidden';
  };
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
