#!/usr/bin/env node
/**
 * Entrypoint. Loads config, starts the agent, and stays up.
 */
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadConfig} from './config.js';
import {createAgent} from './index.js';

const configPath = resolve(process.env.AGENT_CONFIG ?? 'agent.config.json');
const statePath = resolve(process.env.AGENT_STATE ?? 'state.json');

function log(message: string, detail?: unknown): void {
	const line = `${new Date().toISOString()} ${message}`;
	if (detail === undefined) {
		console.log(line);
	} else {
		console.log(line, detail);
	}
}

const {config, warning} = loadConfig(configPath);
if (warning) {
	log('CONFIG WARNING', warning);
}

const agent = createAgent({config, statePath, log});
agent.start();

// Every boot wakes the agent with the facts of its own start. A marker left
// by scripts/restart.sh means a deliberate self-restart, whose completion the
// owner should hear about — two restarts failed silently on 2026-08-20/21 and
// the owner had to ask whether anything was running. No marker means a crash
// or host reboot, worth flagging even more. What to tell the owner is the
// agent's call; this only delivers the facts.
const restartMarker = resolve('.restart-pending');
const restartRequestedAt = existsSync(restartMarker)
	? readFileSync(restartMarker, 'utf8').trim()
	: undefined;
if (restartRequestedAt !== undefined) {
	rmSync(restartMarker, {force: true});
}

const bootEvent = {
	id: `boot-${Date.now()}`,
	channel: 'system',
	threadId: '',
	text: restartRequestedAt
		? `Self-restart completed: the restart requested at ${restartRequestedAt} has come up, as of ${new Date().toISOString()}. Whether to tell the owner is your call: confirm when the restart was part of an active exchange or the owner is waiting on it; a routine restart needs no announcement.`
		: `The service started at ${new Date().toISOString()} with no pending-restart marker — an unexpected start, e.g. a crash or host reboot. Consider telling the owner, and check for anything missed while down.`,
	timestamp: new Date(),
};
agent.dispatcher.markSeen(bootEvent.id);
void agent.runner.submit(bootEvent).catch((error: unknown) => {
	log('boot notice run failed', error);
});

// If we fell back to a previous config (M4), tell the owner rather than
// silently running something they did not intend.
if (warning) {
	const channel = agent.channels[0];
	const thread = config.channels.whatsapp?.ownerJids[0] ?? config.channels.email?.ownerAddress;
	if (channel && thread) {
		void channel.send({channel: channel.id, threadId: thread, text: warning})
			.catch((error: unknown) => {
				log('could not deliver config warning', error);
			});
	}
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		log('shutting down', signal);
		// Stop taking on new work, then give sends already in flight a moment to
		// land. A reply is recorded as "sent by me" only once the bridge returns
		// its message id, so exiting the instant the signal arrives loses that
		// record — and the next process reads the reply back as a new message
		// from Adam. Observed twice while restarting to pick up config changes.
		agent.stop();
		void agent.drain().finally(() => {
			process.exit(0);
		});
	});
}
