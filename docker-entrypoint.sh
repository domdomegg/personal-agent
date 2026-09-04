#!/bin/sh
# Wait until the agent has what it needs, then run it.
#
# On a fresh volume there is neither a checkout nor a Claude Code credential,
# and the agent cannot do anything without both — every reply and every poll
# goes through claude or call-mcp. So it waits and says so, rather than
# crash-looping. Get a shell with
# `kubectl exec -it deploy/personal-agent-deployment -- bash` — on Adam's
# cluster the deployment carries a -deployment suffix, and the bare name is a
# confusing NotFound. Checkouts live under $HOME/src, mirroring the layout on
# Adam's laptop, and deliberately not at $HOME itself: credentials such as
# ~/.kube/config sit outside every git tree, so no `git add -A` can commit
# them. AGENT_REPO clones the checkout below, so what is left is
# `npm ci && npm run build`, then `claude` to log in, and it starts by itself.
# Both live on the volume, so this is first boot only.
set -eu

HOME_DIR=/home/agent
CREDS="$HOME_DIR/.claude/.credentials.json"
REPO="$HOME_DIR/src/personal-agent"

# The desktop (see scripts/desktop/desktop-start) runs as the `desktop` user
# in this same container. Keep the agent's credentials out of its reach: the
# home stays world-traversable (755) so the shared desktop dir underneath is
# usable, but the directories holding secrets are root-only.
for d in "$HOME_DIR/.claude" "$HOME_DIR/.kube" "$HOME_DIR/.config" "$HOME_DIR/.ssh"; do
	[ -d "$d" ] && chmod 700 "$d"
done
desktop-start || echo "[entrypoint] desktop failed to start; carrying on without it" >&2

# Claude Code is updated at boot rather than baked in: the image only rebuilds
# when the Dockerfile changes, and a model pin once outran the baked version
# (2.1.241, when claude-fable-5-1 needed 2.1.251), leaving every run failing
# until someone noticed. The update installs into /home/agent/.local on the
# volume, which PATH prefers over the image's copy (see the Dockerfile). Best
# effort with a bound: no network is not a reason to stay down.
echo "[entrypoint] claude update" >&2
timeout 300 claude update \
	|| echo "[entrypoint] claude update failed; carrying on with $(claude --version 2>/dev/null || echo 'unknown version')" >&2

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
