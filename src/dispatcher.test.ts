import {
	describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Dispatcher} from './dispatcher.js';
import type {AgentEvent, Channel} from './types.js';

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'agent-test-'));
});

afterEach(() => {
	rmSync(directory, {recursive: true, force: true});
});

function event(id: string, at = new Date()): AgentEvent {
	return {
		id, channel: 'fake', threadId: 't', text: id, timestamp: at,
	};
}

/** Stands in for the Runner; records what it was handed. */
function fakeRunner() {
	const submitted: AgentEvent[] = [];
	return {
		submitted,
		isRunning: false,
		async submit(e: AgentEvent) {
			submitted.push(e);
		},
	};
}

function fakeChannel(batches: AgentEvent[][]): Channel {
	let index = 0;
	return {
		id: 'fake',
		async poll() {
			const batch = batches[index] ?? [];
			index += 1;
			return batch;
		},
		async send() {
			// Replies are not under test here.
		},
	};
}

const polling = {idleIntervalMs: 1000, activeIntervalMs: 100, activeWindowMs: 1000};

describe('dispatcher', () => {
	test('dispatches new events', async () => {
		const runner = fakeRunner();
		const dispatcher = new Dispatcher({
			channels: [fakeChannel([[event('a'), event('b')]])],
			runner,
			statePath: join(directory, 'state.json'),
			polling,
		});

		await dispatcher.tick();
		expect(runner.submitted.map((e) => e.id)).toEqual(['a', 'b']);
	});

	test('never dispatches the same event twice', async () => {
		const runner = fakeRunner();
		const dispatcher = new Dispatcher({
			channels: [fakeChannel([[event('a')], [event('a'), event('b')]])],
			runner,
			statePath: join(directory, 'state.json'),
			polling,
		});

		await dispatcher.tick();
		await dispatcher.tick();
		expect(runner.submitted.map((e) => e.id)).toEqual(['a', 'b']);
	});

	// F5/F6: a fresh process reading existing state must not replay.
	test('deduplicates across restarts', async () => {
		const statePath = join(directory, 'state.json');
		const first = fakeRunner();
		await new Dispatcher({
			channels: [fakeChannel([[event('a')]])],
			runner: first,
			statePath,
			polling,
		}).tick();

		const second = fakeRunner();
		await new Dispatcher({
			channels: [fakeChannel([[event('a'), event('b')]])],
			runner: second,
			statePath,
			polling,
		}).tick();

		expect(first.submitted.map((e) => e.id)).toEqual(['a']);
		expect(second.submitted.map((e) => e.id)).toEqual(['b']);
	});

	test('orders events by their original timestamp', async () => {
		const runner = fakeRunner();
		const older = event('older', new Date(Date.now() - 10_000));
		const newer = event('newer', new Date());
		const dispatcher = new Dispatcher({
			channels: [fakeChannel([[newer, older]])],
			runner,
			statePath: join(directory, 'state.json'),
			polling,
		});

		await dispatcher.tick();
		expect(runner.submitted.map((e) => e.id)).toEqual(['older', 'newer']);
	});

	// A channel whose polls keep failing means messages are silently missed, so
	// the agent is woken to investigate rather than the failure only being logged.
	describe('read receipts', () => {
		/** Records what it was asked to acknowledge. */
		function readableChannel(batches: AgentEvent[][], onMark?: () => Promise<void>): {
			channel: Channel;
			acknowledged: string[][];
		} {
			const base = fakeChannel(batches);
			const acknowledged: string[][] = [];
			return {
				acknowledged,
				channel: {
					...base,
					async markRead(events) {
						acknowledged.push(events.map((e) => e.id));
						await onMark?.();
					},
				},
			};
		}

		test('acknowledges dispatched events', async () => {
			const {channel, acknowledged} = readableChannel([[event('a'), event('b')]]);
			const dispatcher = new Dispatcher({
				channels: [channel],
				runner: fakeRunner(),
				statePath: join(directory, 'state.json'),
				polling,
			});

			await dispatcher.tick();
			expect(acknowledged).toEqual([['a', 'b']]);
		});

		// Acknowledging a message twice would be harmless but pointless traffic,
		// and would mean the receipt no longer tracks "newly handed to the agent".
		test('does not acknowledge an event again on a later poll', async () => {
			const {channel, acknowledged} = readableChannel([[event('a')], [event('a'), event('b')]]);
			const dispatcher = new Dispatcher({
				channels: [channel],
				runner: fakeRunner(),
				statePath: join(directory, 'state.json'),
				polling,
			});

			await dispatcher.tick();
			await dispatcher.tick();
			expect(acknowledged).toEqual([['a'], ['b']]);
		});

		// The poll-failure alert is the harness talking to itself. Sending it back
		// to the bridge as a read receipt would be nonsense, and its id is not a
		// WhatsApp message id at all.
		test('never acknowledges a synthetic poll-failure alert', async () => {
			const acknowledged: string[][] = [];
			const channel: Channel = {
				id: 'broken',
				async poll(): Promise<AgentEvent[]> {
					throw new Error('connector down');
				},
				async send() {
					// Never reached.
				},
				async markRead(events) {
					acknowledged.push(events.map((e) => e.id));
				},
			};

			const runner = fakeRunner();
			const dispatcher = new Dispatcher({
				channels: [channel],
				runner,
				statePath: join(directory, 'state.json'),
				polling,
			});

			for (let i = 0; i < 60; i++) {
				// eslint-disable-next-line no-await-in-loop -- ticks are sequential by nature.
				await dispatcher.tick();
			}

			expect(runner.submitted).toHaveLength(1);
			expect(acknowledged).toEqual([]);
		});

		// A receipt is a courtesy. Losing one must not cost the message.
		test('dispatches normally when acknowledgement fails', async () => {
			const {channel} = readableChannel(
				[[event('a')]],
				async () => {
					throw new Error('bridge unreachable');
				},
			);

			const logged: string[] = [];
			const runner = fakeRunner();
			const dispatcher = new Dispatcher({
				channels: [channel],
				runner,
				statePath: join(directory, 'state.json'),
				polling,
				log(message) {
					logged.push(message);
				},
			});

			await expect(dispatcher.tick()).resolves.toBeUndefined();
			expect(runner.submitted.map((e) => e.id)).toEqual(['a']);

			// The rejection is handled asynchronously, so let it settle.
			await new Promise((resolve) => {
				setTimeout(resolve, 10);
			});
			expect(logged).toContain('failed to mark read');
		});
	});

	describe('poll failure alerts', () => {
		/** Fails every poll, so the failure streak is under our control. */
		function brokenChannel(error: unknown = new Error('connector down')): Channel {
			return {
				id: 'broken',
				async poll(): Promise<AgentEvent[]> {
					throw error;
				},
				async send() {
					// Never reached.
				},
			};
		}

		async function tickTimes(dispatcher: Dispatcher, times: number): Promise<void> {
			for (let i = 0; i < times; i++) {
				// eslint-disable-next-line no-await-in-loop -- ticks are sequential by nature.
				await dispatcher.tick();
			}
		}

		test('stays quiet below the threshold, then wakes the agent', async () => {
			const runner = fakeRunner();
			const dispatcher = new Dispatcher({
				channels: [brokenChannel()],
				runner,
				statePath: join(directory, 'state.json'),
				polling,
			});

			await tickTimes(dispatcher, 59);
			expect(runner.submitted).toHaveLength(0);

			await dispatcher.tick();
			expect(runner.submitted).toHaveLength(1);
			expect(runner.submitted[0]?.channel).toBe('system');
			expect(runner.submitted[0]?.text).toContain('failed 60 times in a row');
		});

		test('includes the underlying error so the agent can diagnose it', async () => {
			const runner = fakeRunner();
			const error = Object.assign(new Error('Command failed: call-mcp'), {
				stdout: '{"error":"The Claude Code token expired 9 minute(s) ago."}',
			});
			const dispatcher = new Dispatcher({
				channels: [brokenChannel(error)],
				runner,
				statePath: join(directory, 'state.json'),
				polling,
			});

			await tickTimes(dispatcher, 60);
			expect(runner.submitted[0]?.text).toContain('Command failed: call-mcp');
			expect(runner.submitted[0]?.text).toContain('token expired');
		});

		// Backs off geometrically: a long outage nags without waking the agent
		// on every single poll.
		test('re-alerts on an exponential schedule', async () => {
			const runner = fakeRunner();
			const dispatcher = new Dispatcher({
				channels: [brokenChannel()],
				runner,
				statePath: join(directory, 'state.json'),
				polling,
			});

			await tickTimes(dispatcher, 240);
			expect(runner.submitted.map((e) => e.id)).toEqual([
				'poll-failure:broken:60',
				'poll-failure:broken:120',
				'poll-failure:broken:240',
			]);
		});

		test('a successful poll clears the streak', async () => {
			const runner = fakeRunner();
			let failing = true;
			const flaky: Channel = {
				id: 'flaky',
				async poll(): Promise<AgentEvent[]> {
					if (failing) {
						throw new Error('connector down');
					}

					return [];
				},
				async send() {
					// Not under test.
				},
			};

			const dispatcher = new Dispatcher({
				channels: [flaky],
				runner,
				statePath: join(directory, 'state.json'),
				polling,
			});

			await tickTimes(dispatcher, 59);
			failing = false;
			await dispatcher.tick();
			failing = true;
			await tickTimes(dispatcher, 59);

			// Without the reset the 60th cumulative failure would have alerted.
			expect(runner.submitted).toHaveLength(0);
		});

		// The counter is in memory, but the alerts it emits go through the same
		// seen-set as messages, so a restart mid-outage cannot replay one.
		test('does not replay an alert already dispatched before a restart', async () => {
			const statePath = join(directory, 'state.json');
			const first = fakeRunner();
			await tickTimes(new Dispatcher({
				channels: [brokenChannel()], runner: first, statePath, polling,
			}), 60);

			const second = fakeRunner();
			await tickTimes(new Dispatcher({
				channels: [brokenChannel()], runner: second, statePath, polling,
			}), 60);

			expect(first.submitted.map((e) => e.id)).toEqual(['poll-failure:broken:60']);
			expect(second.submitted).toHaveLength(0);
		});
	});

	// One failing channel must not stop the others.
	test('survives a channel that throws', async () => {
		const runner = fakeRunner();
		const broken: Channel = {
			id: 'broken',
			async poll() {
				throw new Error('connector down');
			},
			async send() {
				// Never reached.
			},
		};

		const dispatcher = new Dispatcher({
			channels: [broken, fakeChannel([[event('a')]])],
			runner,
			statePath: join(directory, 'state.json'),
			polling,
		});

		await dispatcher.tick();
		expect(runner.submitted.map((e) => e.id)).toEqual(['a']);
	});

	// O3: no events must mean no agent invocation at all.
	test('does not invoke the runner when nothing arrives', async () => {
		const runner = fakeRunner();
		const dispatcher = new Dispatcher({
			channels: [fakeChannel([[]])],
			runner,
			statePath: join(directory, 'state.json'),
			polling,
		});

		await dispatcher.tick();
		expect(runner.submitted).toHaveLength(0);
	});

	// The real submit() resolves only when the whole run ends. Polling must not
	// wait on that: messages sent mid-run were otherwise left unfetched on the
	// bridge until the run finished, so they looked like they arrived late.
	test('keeps polling while a run is still in flight', async () => {
		const submitted: AgentEvent[] = [];
		// Never resolves, standing in for a long-running agent turn.
		const runner = {
			isRunning: false,
			submitted,
			async submit(e: AgentEvent) {
				submitted.push(e);
				return new Promise<void>(() => {
					// Intentionally never settles.
				});
			},
		};

		const dispatcher = new Dispatcher({
			channels: [fakeChannel([[event('first')], [event('second')]])],
			runner,
			statePath: join(directory, 'state.json'),
			polling,
		});

		// Would hang here if tick() awaited run completion.
		await dispatcher.tick();
		await dispatcher.tick();

		expect(submitted.map((e) => e.id)).toEqual(['first', 'second']);
	});
});
