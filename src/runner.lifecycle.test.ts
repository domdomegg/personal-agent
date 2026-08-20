/**
 * Run-lifecycle regression tests for the linger-race fork of 2026-08-20.
 *
 * The failure: a message arriving in the linger window after a turn's result
 * joined the run but did not cancel the idle countdown. The runner tore the
 * run down while the child was still working, and the next event spawned a
 * second child resuming the same session concurrently — forking its context
 * and duplicating real work.
 *
 * These drive the real Runner against a stub `claude` that speaks just enough
 * stream-json, and assert the invariant that matters: children never overlap.
 */
import {describe, test, expect} from 'vitest';
import {
	mkdtempSync, writeFileSync, chmodSync, readFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Runner} from './runner.js';
import type {AgentEvent, OutboundMessage} from './types.js';

type StubOptions = {
	/** How long the stub "works" on each message before its result. */
	delayMs?: number;
	/** How long the stub lingers after stdin closes before exiting. */
	exitDelayMs?: number;
	/** File the stub appends `spawn`/`exit` lines to. */
	logPath: string;
};

/**
 * A stub Claude Code: answers every user message with an addressed ack and a
 * result line, and records its own spawn and exit so tests can assert that
 * two of it never ran at once.
 */
function stubClaude(options: StubOptions): string {
	const directory = mkdtempSync(join(tmpdir(), 'claude-stub-'));
	const path = join(directory, 'claude-stub');
	writeFileSync(path, `#!/usr/bin/env node
const {appendFileSync} = require('node:fs');
const {createInterface} = require('node:readline');
const DELAY = ${options.delayMs ?? 0};
const EXIT_DELAY = ${options.exitDelayMs ?? 0};
const LOG = ${JSON.stringify(options.logPath)};
appendFileSync(LOG, 'spawn ' + process.pid + ' ' + Date.now() + '\\n');
const rl = createInterface({input: process.stdin});
let queue = Promise.resolve();
let n = 0;
rl.on('line', (line) => {
	let message;
	try { message = JSON.parse(line); } catch { return; }
	if (message.type !== 'user') return;
	n += 1;
	const i = n;
	queue = queue.then(async () => {
		if (DELAY) await new Promise((r) => setTimeout(r, DELAY));
		process.stdout.write(JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text: '>>> reply channel=whatsapp thread=t\\nack ' + i}]}}) + '\\n');
		process.stdout.write(JSON.stringify({type: 'result', is_error: false, num_turns: 1}) + '\\n');
	});
});
rl.on('close', () => {
	void queue.then(async () => {
		if (EXIT_DELAY) await new Promise((r) => setTimeout(r, EXIT_DELAY));
		appendFileSync(LOG, 'exit ' + process.pid + ' ' + Date.now() + '\\n');
		process.exit(0);
	});
});
`);
	chmodSync(path, 0o755);
	return path;
}

function makeEvent(text: string): AgentEvent {
	return {
		id: randomUUID(),
		channel: 'whatsapp',
		threadId: 't',
		text,
		timestamp: new Date(),
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('timed out waiting for condition');
		}

		// eslint-disable-next-line no-await-in-loop -- polling loop
		await new Promise((resolve) => {
			setTimeout(resolve, 10);
		});
	}
}

type LifecycleLine = {kind: string; pid: string; at: number};

function lifecycle(logPath: string): LifecycleLine[] {
	const raw = readFileSync(logPath, 'utf8').trim();
	if (raw === '') {
		return [];
	}

	return raw.split('\n').map((line) => {
		const [kind, pid, at] = line.split(' ');
		return {kind: kind ?? '', pid: pid ?? '', at: Number(at)};
	});
}

function makeRunner(claudePath: string, sent: OutboundMessage[], lingerMs: number): Runner {
	return new Runner({
		sessionId: randomUUID(),
		systemPrompt: 'stub',
		model: 'stub-model',
		workingDirectory: tmpdir(),
		claudePath,
		lingerMs,
		async onOutbound(message) {
			sent.push(message);
		},
	});
}

describe('run lifecycle', () => {
	// The 2026-08-20 fork: an event joining during the linger window must keep
	// the run owned, and an event arriving during wind-down must wait for the
	// next run — under no circumstances may two children exist at once.
	test('children never overlap, whenever events arrive', async () => {
		const scratch = mkdtempSync(join(tmpdir(), 'runner-lifecycle-'));
		const logPath = join(scratch, 'lifecycle.log');
		writeFileSync(logPath, '');
		// Work takes 250ms, well past the 100ms linger; the stub also lingers
		// 300ms after stdin closes, standing in for a background task holding
		// the process open — the window that used to fork the session.
		const claudePath = stubClaude({delayMs: 250, exitDelayMs: 300, logPath});
		const sent: OutboundMessage[] = [];
		const runner = makeRunner(claudePath, sent, 100);

		// A starts the run; its ack arrives ~250ms in, with the idle countdown
		// armed by its result.
		const chain = runner.submit(makeEvent('A'));
		await waitFor(() => sent.length === 1);

		// B lands inside the linger window: it must join this run, not tear it
		// down mid-work.
		void runner.submit(makeEvent('B'));
		await waitFor(() => sent.length === 2);

		// C lands during wind-down: after B's result the countdown fires and
		// stdin closes, but the child holds on for its exit delay. C must queue
		// for the next run rather than spawn a concurrent child.
		await waitFor(() => !runner.isRunning || lifecycle(logPath).length > 1 || sent.length === 2);
		await new Promise((resolve) => {
			setTimeout(resolve, 150);
		});
		void runner.submit(makeEvent('C'));
		await waitFor(() => sent.length === 3);
		await chain;

		const lines = lifecycle(logPath);
		const spawns = lines.filter((l) => l.kind === 'spawn');
		expect(spawns.length).toBeGreaterThanOrEqual(1);
		expect(spawns.length).toBeLessThanOrEqual(2);

		// The invariant: strict alternation. Every spawn after the first must
		// come after the previous child's exit.
		for (const [index, line] of lines.entries()) {
			expect(line.kind).toBe(index % 2 === 0 ? 'spawn' : 'exit');
		}

		expect(sent.map((m) => m.text)).toEqual(['ack 1', 'ack 2', 'ack 1']);
	});

	test('the submit chain resolves only when the backlog has drained', async () => {
		const scratch = mkdtempSync(join(tmpdir(), 'runner-lifecycle-'));
		const logPath = join(scratch, 'lifecycle.log');
		writeFileSync(logPath, '');
		const claudePath = stubClaude({delayMs: 50, exitDelayMs: 200, logPath});
		const sent: OutboundMessage[] = [];
		const runner = makeRunner(claudePath, sent, 60);

		const chain = runner.submit(makeEvent('A'));
		await waitFor(() => sent.length === 1);

		// Wait out the linger so the run is winding down, then queue an event.
		await new Promise((resolve) => {
			setTimeout(resolve, 120);
		});
		void runner.submit(makeEvent('B'));

		await chain;

		// The chain promise covered the backlog run too: B's ack is already
		// there, from a second (non-overlapping) child.
		expect(sent).toHaveLength(2);
		const lines = lifecycle(logPath);
		expect(lines.map((l) => l.kind)).toEqual(['spawn', 'exit', 'spawn', 'exit']);
	});
});
