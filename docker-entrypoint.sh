#!/bin/sh
# Wait until the agent has what it needs, then run it.
#
# On a fresh volume there is neither a checkout nor a Claude Code credential,
# and the agent cannot do anything without both — every reply and every poll
# goes through claude or call-mcp. So it waits and says so, rather than
# crash-looping. Get a shell with
# `kubectl exec -it deploy/personal-agent-deployment -- bash` — on Adam's
# cluster the deployment carries a -deployment suffix, and the bare name is a
# confusing NotFound. AGENT_REPO clones the checkout below, so what is left is
# `npm ci && npm run build`, then `claude` to log in, and it starts by itself.
# Both live on the volume, so this is first boot only.
set -eu

HOME_DIR=/home/agent
CREDS="$HOME_DIR/.claude/.credentials.json"
REPO="$HOME_DIR/personal-agent"

if [ ! -d "$REPO/.git" ] && [ -n "${AGENT_REPO:-}" ]; then
	echo "[entrypoint] cloning $AGENT_REPO" >&2
	git clone "$AGENT_REPO" "$REPO" || true
fi

while [ ! -f "$REPO/dist/main.js" ] || [ ! -f "$CREDS" ]; do
	[ -f "$REPO/dist/main.js" ] || echo "[entrypoint] waiting: no build at $REPO (git clone it, then npm ci && npm run build)" >&2
	[ -f "$CREDS" ] || echo "[entrypoint] waiting: Claude Code not authenticated (run 'claude')" >&2
	sleep 15
done

echo "[entrypoint] starting agent" >&2
cd "$REPO"
exec node ./dist/main.js
