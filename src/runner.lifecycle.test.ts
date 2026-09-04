/**
 * Run-lifecycle regression tests.
 *
 * Two incidents drive these. The linger-race fork of 2026-08-20: a message
 * arriving after a turn's result joined the run without cancelling the idle
 * countdown, the runner tore the run down mid-work, and the next event forked
 * the session into a second concurrent child. And the dropped question of the
 * same day: a run wound down leaving an owner message unanswered, with
 * nothing to catch it — now guarded by the reply-check nudge, which clears
 * only when the channel layer reports the agent's own send (noteReplySent).
 *
 * These drive the real Runner against a stub `claude` that speaks just enough
 * stream-json, and assert the invariants that matter: children never overlap,
 * and unanswered owner messages are challenged exactly once.
 */
import {describe, test, expect} from 'vitest';
import {
	mkdtempSync, writeFileSync, chmodSync, readFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Runner} from './runner.js';
import type {AgentEvent} from './types.js';

type StubOptions = {
	/** How long the stub "works" on each message before its result. */
	delayMs?: number;
	/** How long the stub lingers after stdin closes before exiting. */
	exitDelayMs?: number;
	/** File the stub appends `spawn`/`exit` lines to. */
	logPath: string;
	/** File the stub appends `msg`/`nudge` per received user message, if set. */
	recvLogPath?: string;
	/** A --model the stub rejects with a synthetic "API Error: 400", like a CLI too old for it. */
	rejectModel?: string;
};

/**
 * A stub Claude Code: emits a result line for every user message, and records
 * its own spawn and exit so tests can assert that two of it never ran at
 * once. It never sends anything — the real agent sends over MCP, which the
 * runner cannot see either; only noteReplySent tells it a reply happened.
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
const RECV_LOG = ${JSON.stringify(options.recvLogPath ?? '')};
const REJECT = ${JSON.stringify(options.rejectModel ?? '')};
const MODEL = process.argv[process.argv.indexOf('--model') + 1];
appendFileSync(LOG, 'spawn ' + process.pid + ' ' + Date.now() + ' ' + MODEL + '\\n');
const rl = createInterface({input: process.stdin});
let queue = Promise.resolve();
rl.on('line', (line) => {
	let message;
	try { message = JSON.parse(line); } catch { return; }
	if (message.type !== 'user') return;
	const text = (message.message.content ?? []).map((b) => b.text ?? '').join('');
	const isNudge = text.includes('Reply check');
	if (RECV_LOG) appendFileSync(RECV_LOG, (isNudge ? 'nudge' : 'msg') + '\\n');
	queue = queue.then(async () => {
		if (DELAY) await new Promise((r) => setTimeout(r, DELAY));
		if (REJECT && MODEL === REJECT) {
			process.stdout.write(JSON.stringify({type: 'assistant', message: {model: '<synthetic>', stop_reason: 'stop_sequence', content: [{type: 'text', text: 'API Error: 400 Claude Code 0.0.1 does not support this model; version 9.9.9 or newer is required.'}]}}) + '\\n');
			process.stdout.write(JSON.stringify({type: 'result', is_error: true, num_turns: 1}) + '\\n');
			return;
		}
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

function makeEvent(text: string, note?: string): AgentEvent {
	return {
		id: randomUUID(),
		channel: 'whatsapp',
		threadId: 't',
		text,
		timestamp: new Date(),
		note,
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

type LifecycleLine = {kind: string; pid: string; at: number; model?: string};

function lifecycle(logPath: string): LifecycleLine[] {
	const raw = readFileSync(logPath, 'utf8').trim();
	if (raw === '') {
		return [];
	}

	return raw.split('\n').map((line) => {
		const [kind, pid, at, model] = line.split(' ');
		return {
			kind: kind ?? '', pid: pid ?? '', at: Number(at), model,
		};
	});
}

function received(recvLogPath: string): string[] {
	const raw = readFileSync(recvLogPath, 'utf8').trim();
	return raw === '' ? [] : raw.split('\n');
}

function makeRunner(claudePath: string, lingerMs: number): Runner {
	return new Runner({
		sessionId: randomUUID(),
		model: 'stub-model',
		workingDirectory: tmpdir(),
		claudePath,
		lingerMs,
	});
}

function scratchLogs(): {logPath: string; recvLogPath: string} {
	const scratch = mkdtempSync(join(tmpdir(), 'runner-lifecycle-'));
	const logPath = join(scratch, 'lifecycle.log');
	const recvLogPath = join(scratch, 'recv.log');
	writeFileSync(logPath, '');
	writeFileSync(recvLogPath, '');
	return {logPath, recvLogPath};
}

describe('run lifecycle', () => {
	// The 2026-08-20 fork: an event joining during the linger window must keep
	// the run owned, and an event arriving during wind-down must wait for the
	// next run — under no circumstances may two children exist at once.
	// Watched events, so the reply-check stays out of a test about ownership.
	test('children never overlap, whenever events arrive', async () => {
		const {logPath, recvLogPath} = scratchLogs();
		// Work takes 250ms, well past the 100ms linger; the stub also lingers
		// 300ms after stdin closes, standing in for a background task holding
		// the process open — the window that used to fork the session.
		const claudePath = stubClaude({
			delayMs: 250, exitDelayMs: 300, logPath, recvLogPath,
		});
		const runner = makeRunner(claudePath, 100);

		// A starts the run.
		const chain = runner.submit(makeEvent('A', 'watch'));
		await waitFor(() => received(recvLogPath).length === 1);

		// B aims for the linger window after A's result (~250ms work + 100ms
		// linger): it must join this run, not tear it down — and if timing
		// drifts and it lands in wind-down instead, it must backlog, never
		// fork. Both outcomes satisfy the alternation invariant below.
		await new Promise((resolve) => {
			setTimeout(resolve, 300);
		});
		void runner.submit(makeEvent('B', 'watch'));
		await waitFor(() => received(recvLogPath).length === 2);

		// C lands during wind-down: the child holds on for its exit delay, so
		// C must queue for the next run rather than spawn a concurrent child.
		await new Promise((resolve) => {
			setTimeout(resolve, 500);
		});
		void runner.submit(makeEvent('C', 'watch'));
		await waitFor(() => received(recvLogPath).length === 3);
		await chain;

		const lines = lifecycle(logPath);
		const spawns = lines.filter((l) => l.kind === 'spawn');
		expect(spawns.length).toBeGreaterThanOrEqual(1);
		expect(spawns.length).toBeLessThanOrEqual(3);

		// The invariant: strict alternation. Every spawn after the first must
		// come after the previous child's exit.
		for (const [index, line] of lines.entries()) {
			expect(line.kind).toBe(index % 2 === 0 ? 'spawn' : 'exit');
		}

		expect(received(recvLogPath)).toEqual(['msg', 'msg', 'msg']);
	});

	test('the submit chain resolves only when the backlog has drained', async () => {
		const {logPath, recvLogPath} = scratchLogs();
		const claudePath = stubClaude({
			delayMs: 50, exitDelayMs: 200, logPath, recvLogPath,
		});
		const runner = makeRunner(claudePath, 60);

		const chain = runner.submit(makeEvent('A', 'watch'));
		await waitFor(() => received(recvLogPath).length === 1);

		// Wait out the linger so the run is winding down, then queue an event.
		await new Promise((resolve) => {
			setTimeout(resolve, 120);
		});
		void runner.submit(makeEvent('B', 'watch'));

		await chain;

		// The chain promise covered the backlog run too: B was handled by a
		// second (non-overlapping) child before the chain resolved.
		expect(received(recvLogPath)).toEqual(['msg', 'msg']);
		const lines = lifecycle(logPath);
		expect(lines.map((l) => l.kind)).toEqual(['spawn', 'exit', 'spawn', 'exit']);
	});

	// The 2026-08-20 dropped-question failure: a run wound down with an owner
	// message unanswered and the owner staring at silence. The runner must
	// challenge it once — and only once, so a deliberate non-reply (stated to
	// the notice) still lets the run close rather than looping forever.
	test('an unanswered owner message is nudged exactly once before wind-down', async () => {
		const {logPath, recvLogPath} = scratchLogs();
		const claudePath = stubClaude({logPath, recvLogPath, exitDelayMs: 50});
		const runner = makeRunner(claudePath, 60);

		// Resolving at all also proves the nudge is not a nag loop.
		await runner.submit(makeEvent('needs an answer'));

		expect(received(recvLogPath)).toEqual(['msg', 'nudge']);
		expect(lifecycle(logPath).map((l) => l.kind)).toEqual(['spawn', 'exit']);
	});

	// The agent sends over MCP, invisibly to the runner; the channel layer
	// reports the echo of that send via noteReplySent. A thread answered that
	// way must not be nudged.
	test('noteReplySent settles the thread and suppresses the nudge', async () => {
		const {logPath, recvLogPath} = scratchLogs();
		// Work delay gives the test room to report the reply mid-run, before
		// the idle countdown can fire.
		const claudePath = stubClaude({
			delayMs: 150, logPath, recvLogPath, exitDelayMs: 50,
		});
		const runner = makeRunner(claudePath, 60);

		const chain = runner.submit(makeEvent('needs an answer'));
		await waitFor(() => received(recvLogPath).length === 1);
		runner.noteReplySent('whatsapp', 't');
		await chain;

		expect(received(recvLogPath)).toEqual(['msg']);
	});

	test('watched-chat messages are heard without demanding a reply', async () => {
		const {logPath, recvLogPath} = scratchLogs();
		const claudePath = stubClaude({logPath, recvLogPath, exitDelayMs: 50});
		const runner = makeRunner(claudePath, 60);

		await runner.submit(makeEvent('background chatter', 'summarise weekly'));

		expect(received(recvLogPath)).toEqual(['msg']);
	});

	// 2026-09-03: the configured model was rejected by an older Claude Code on
	// every run, and nothing switched away from it. The first rejection must
	// move to the fallback (carrying the same events plus a notice), and later
	// runs must go straight to the fallback rather than fail again first.
	test('a model the CLI rejects is swapped for the fallback, and stays swapped', async () => {
		const {logPath, recvLogPath} = scratchLogs();
		const claudePath = stubClaude({
			logPath, recvLogPath, rejectModel: 'new-model',
		});
		const runner = new Runner({
			sessionId: randomUUID(),
			model: 'new-model',
			fallbackModel: 'stub-model',
			workingDirectory: tmpdir(),
			claudePath,
			lingerMs: 50,
		});

		await runner.submit(makeEvent('A', 'watch'));
		let spawns = lifecycle(logPath).filter((l) => l.kind === 'spawn');
		expect(spawns.map((l) => l.model)).toEqual(['new-model', 'stub-model']);
		// The rejected run saw A; the fallback run saw the notice and A again.
		expect(received(recvLogPath)).toEqual(['msg', 'msg', 'msg']);

		await runner.submit(makeEvent('B', 'watch'));
		spawns = lifecycle(logPath).filter((l) => l.kind === 'spawn');
		expect(spawns.map((l) => l.model)).toEqual(['new-model', 'stub-model', 'stub-model']);
	});
});
