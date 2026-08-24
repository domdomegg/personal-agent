# personal-agent

Reach Claude Code from WhatsApp, email, or a schedule — as one continuous
conversation.

MCP is pull-only: nothing wakes Claude when a message arrives. This is the
missing push path, and nothing more. Claude Code is the agent; the MCP servers
are the capabilities; this just decides when to wake them and where to send the
answer.

> **Work in progress, and largely vibe coded.** Take it as inspiration rather
> than something to depend on.

## How it works

```
WhatsApp ─┐
email    ─┼─▶ poll ─▶ dispatcher ─▶ claude -p (one session) ─▶ reply
schedule ─┘            (dedupe)         │
                                        └─▶ MCP servers
```

- **One conversation.** Every event feeds the same Claude Code session, so
  context carries across messages, across channels, and across restarts. Ask on
  WhatsApp, follow up by email, and it knows what you mean.
- **Events join a live run.** A message arriving mid-run is written to the
  running process and picked up at its next tool-call boundary, rather than
  queueing behind it.
- **Idle is free.** Claude Code is invoked only when there is a real event.
- **It can change itself.** The agent runs in its own repo and can edit its
  config, schedule, system prompt, and code, then commit and restart.

## Setup

```bash
npm install && npm run build
cp agent.config.example.json agent.config.json   # then edit
npm start
```

Requires `claude` and [`call-mcp`](https://github.com/domdomegg/call-mcp) on
`PATH`. Claude Code uses your existing OAuth login — no API key.

Channels are whatever MCP servers `call-mcp` can reach. This one runs against
[`whatsapp-mcp-extended`](https://github.com/domdomegg/whatsapp-mcp-extended)
and a Gmail server, fronted by
[`mcp-aggregator`](https://github.com/domdomegg/mcp-aggregator) with
[`mcp-auth-wrapper`](https://github.com/domdomegg/mcp-auth-wrapper) in front of
the ones needing per-user auth. Any equivalent setup works — the channel code
only cares about tool names.

Config lives in `agent.config.json` (`AGENT_CONFIG` to override), state in
`state.json` (`AGENT_STATE`).

| Field | Meaning |
| --- | --- |
| `sessionId` | UUID for the continuous conversation. Generate once. |
| `systemPrompt` | Prepended to the agent's instructions. |
| `model` | Claude Code model. Pinned, so it doesn't depend on when the session began. |
| `workingDirectory` | Where Claude Code runs — this repo, so it can edit itself. |
| `channels.whatsapp.ownerJids` | Only messages from these JIDs are acted on. Replies go to the first. WhatsApp surfaces one person under both a phone-number and a `@lid` JID, so you usually want both. |
| `channels.whatsapp.toolPrefix` | Which MCP server backs the channel. Set it when the agent has its own WhatsApp account rather than sharing yours. |
| `channels.email.ownerAddress` | Only mail from here is acted on. |
| `schedule` | Cron entries: `{id, cron, prompt}`. |
| `polling` | Idle/active intervals, and how long "active" lasts. |
| `viewer` | Read-only web view of the transcript, on `localhost:4317`. |

If the config fails to load, the last known-good copy is used and you are told —
so the agent can break its own config and still be reachable to fix it.

## Replying

The agent addresses replies with a routing line:

```
>>> reply channel=whatsapp thread=44700900000@s.whatsapp.net
your message here
```

Prose without that line is thinking, and is not delivered. The marker may appear
after reasoning, so the agent can work through a problem before answering.

## Security

Only the owner can trigger a run — messages from anyone else are dropped before
Claude sees them. Third-party content reaches the agent only when the owner
forwards it, and is presented as data rather than instructions.

Beyond that, boundaries come from the system prompt, not a bespoke permission
layer: the agent is asked to check before payments, messaging third parties, and
unrecoverable deletions. This is guidance to a capable agent, and the acceptance
suite tests it against a real injection attempt.

## Tests

```bash
npm test        # unit; fast, no tokens
npm run test:e2e  # acceptance; runs real Claude Code, slow, costs tokens
```

The acceptance suite covers the requirements end to end — cross-channel memory,
rapid messages, restart safety, self-modification, config recovery, and prompt
injection — with fake channels, so nothing touches WhatsApp or email. It is
excluded from `npm test` and from CI.

## Desktop

The container also runs a small desktop the agent can drive: a virtual X
display (`:1`) with Chromium, viewable in a browser over noVNC on port 6080
(put an authenticating ingress in front of it). `desktop-start` brings it up
at boot; `desktop-chromium [url]` (re)starts Chromium with the DevTools
protocol on `127.0.0.1:9222`. From the agent's shell: `xdotool`, `scrot -o
~/desktop/shot.png`, or CDP against :9222. Chromium runs as the unprivileged
`desktop` user; the only path both sides share is `~/desktop` (browser
profile, downloads, screenshots).
