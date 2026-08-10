#!/usr/bin/env node
/**
 * Entrypoint. Loads config, starts the agent, and stays up.
 */
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
