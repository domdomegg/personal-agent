#!/bin/sh
# PreToolUse hook: refuse background tasks.
#
# The runner winds the claude process down ~2 minutes after its last activity
# (polling.activeWindowMs). Background Bash tasks and Monitors are children of
# that process, so they die with it, silently: the next wake sees only an
# "orphaned" notice and whatever they were waiting for is lost. This happened
# four times on 2026-08-23 despite a note in CLAUDE.md saying not to rely on
# them. Advice does not stick; a denial does. Wait in the foreground instead.
jq -c 'if .tool_name == "Monitor" or (.tool_name == "Bash" and .tool_input.run_in_background == true) then
	{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason:
		"Denied by scripts/hooks/no-background-tasks.sh: background Bash/Monitor tasks die silently when this run winds down (~2 min idle) and their notifications are lost. Wait in the foreground instead: one Bash call with an until-loop + sleep (<=10 min), then re-check the state directly."}}
	else empty end'
