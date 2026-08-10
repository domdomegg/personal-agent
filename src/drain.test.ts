/**
 * Shutdown must not drop the record of a reply that was still being sent.
 *
 * The failure this guards against was seen twice for real: restarting to pick
 * up a config change killed the process moments after it sent a reply, before
 * the bridge returned the message id that marks it as the agent's own. The next
 * process then read that reply back out of the feed and answered it as if it
 * were a new instruction.
 */
import {
	describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createAgent} from './index.js';
import {defaultConfig} from './config.js';
import type {AgentEvent, Channel, Config} from './types.js';

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'agent-drain-'));
});

afterEach(() => {
	rmSync(directory, {recursive: true, force: true});
});

/**
 * A channel whose send resolves only when released, standing in for a bridge
 * call still in flight when the signal arrives.
 */
function slowChannel(onSent: (id: string) => void) {
	let release: (() => void) | undefined;
	const channel: Channel = {
		id: 'whatsapp',
		async poll(): Promise<AgentEvent[]> {
			return [];
		},
		async send() {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			// Mirrors the real channel: the id is only known once the bridge
			// answers, and only then can it be recorded as ours.
			onSent('sent-1');
		},
	};

	return {channel, release: () => release?.()};
}

describe('shutdown', () => {
	test('waits for an in-flight send before exiting', async () => {
		const statePath = join(directory, 'state.json');
		const sent: string[] = [];
		const slow = slowChannel((id) => {
			sent.push(id);
		});

		const config: Config = {
			...defaultConfig(),
			sessionId: randomUUID(),
			workingDirectory: directory,
		};

		const agent = createAgent({config, statePath, channels: [slow.channel]});

		// Start a send and leave it hanging, as at the moment of a restart.
		const sending = agent.runner.options.onOutbound?.({
			channel: 'whatsapp', threadId: 't', text: 'a reply',
		});

		agent.stop();

		let drained = false;
		const draining = agent.drain(1000).then(() => {
			drained = true;
		});

		// Give the event loop several turns. A drain that does not actually wait
		// resolves within these; one that does cannot, since the send is held.
		for (let i = 0; i < 20; i++) {
			// eslint-disable-next-line no-await-in-loop
			await new Promise((resolve) => {
				setTimeout(resolve, 1);
			});
		}

		expect(drained).toBe(false);
		expect(sent).toHaveLength(0);

		slow.release();
		await sending;
		await draining;

		expect(drained).toBe(true);
		expect(sent).toEqual(['sent-1']);
	});

	test('gives up on a send that never returns rather than hanging', async () => {
		const statePath = join(directory, 'state.json');
		const stuck = slowChannel(() => {
			// Never called: this send does not come back.
		});

		const config: Config = {
			...defaultConfig(),
			sessionId: randomUUID(),
			workingDirectory: directory,
		};

		const agent = createAgent({config, statePath, channels: [stuck.channel]});
		void agent.runner.options.onOutbound?.({
			channel: 'whatsapp', threadId: 't', text: 'a reply',
		});

		agent.stop();
		// Resolves on the timeout instead of blocking shutdown forever.
		await expect(agent.drain(50)).resolves.toBeUndefined();
	});

	test('drain is a no-op when nothing is in flight', async () => {
		const statePath = join(directory, 'state.json');
		const config: Config = {
			...defaultConfig(),
			sessionId: randomUUID(),
			workingDirectory: directory,
		};

		const agent = createAgent({config, statePath, channels: []});
		agent.stop();
		await expect(agent.drain(50)).resolves.toBeUndefined();
		// Nothing was written that a later process would have to read back.
		expect(() => readFileSync(statePath, 'utf8')).toThrow();
	});
});
