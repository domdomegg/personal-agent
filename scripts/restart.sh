#!/bin/sh
# Restart the agent from inside a run of the agent itself.
#
# The obvious version — `nohup sh -c 'sleep; kill $AGENT; node dist/main.js' &`
# — does not work, because the shell it spawns is a descendant of the agent it
# kills. On SIGTERM the whole process group goes down and the relaunch never
# happens, leaving the agent dead until someone starts it by hand.
#
# So: detach from the process group, and relaunch without inheriting the dying
# process's stdio. macOS has no setsid, so this double-forks instead — the
# intermediate shell exits immediately and the relaunch is reparented to init,
# out of reach of the agent's process group.
#
# Usage: scripts/restart.sh [pid]
# Defaults to the running `node dist/main.js`, which is what the agent wants
# when restarting itself.
set -eu

cd "$(dirname "$0")/.."
ROOT=$(pwd)
LOG=${AGENT_RESTART_LOG:-/tmp/personal-agent-restart.log}

pid=${1:-$(pgrep -f 'node \./dist/main\.js' | head -1 || true)}
if [ -z "$pid" ]; then
	echo "no running agent found; starting one" >&2
	pid=0
fi

# Build before killing anything: a compile error should leave the running
# agent alone rather than take it down with nothing to come back to.
npm run build >/dev/null

# Left for the next process: on boot it announces the completed restart to the
# agent, which confirms to the owner. If this marker is ever found stale, the
# restart it describes never came up.
date -u +%Y-%m-%dT%H:%M:%SZ > .restart-pending

# Double fork: the outer shell exits at once, so the inner one is reparented to
# init and survives the agent's death. Killing the agent's process group cannot
# reach it.
(
	nohup sh -c "
		if [ '$pid' != '0' ]; then
			# Grace period before killing. A restart triggered by the agent
			# itself is usually mid-turn, and that turn's last message is often
			# the one explaining the restart — killing immediately loses it.
			# A fixed wait rather than watching for the claude child: that is
			# not reliably visible from here, and being early costs a lost
			# message while being late costs only a few seconds.
			sleep \${AGENT_RESTART_GRACE:-20}

			kill -TERM '$pid' 2>/dev/null || true
			# Then wait for exit; drain() gives in-flight sends ~5s.
			i=0
			while kill -0 '$pid' 2>/dev/null && [ \$i -lt 30 ]; do
				sleep 1
				i=\$((i + 1))
			done
		fi
		cd '$ROOT'
		exec node ./dist/main.js
	" >"$LOG" 2>&1 < /dev/null &
) &
# Reap the outer shell so nothing is left waiting on it.
wait $! 2>/dev/null || true

echo "restart scheduled (old pid ${pid}); log: ${LOG}"
