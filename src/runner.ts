/**
 * Owns the Claude Code subprocess.
 *
 * One run at a time (F4). While a run is active, further events are written to
 * its stdin and picked up at the next tool-call boundary (F3) — verified
 * behaviour of `--input-format stream-json`, not a hopeful assumption.
 *
 * Claude Code is invoked with the owner's existing OAuth login (O1): we neither
 * read nor set any API key.
 */
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import type {AgentEvent, OutboundMessage} from './types.js';

export type RunnerOptions = {
	sessionId: string;
	systemPrompt: string;
	/** Claude Code model alias or full name, e.g. `fable` or `claude-fable-5`. */
	model: string;
	/** Retried on once if `model` declines to answer. Omit to disable. */
	fallbackModel?: string | undefined;
	workingDirectory: string;
	/** Overridable so tests can point at a stub. */
	claudePath?: string | undefined;
	/**
	 * How long to hold the run open after a turn completes, so an event arriving
	 * moments later joins it rather than paying for a fresh process. Tests set
	 * this low.
	 */
	lingerMs?: number | undefined;
	/**
	 * Set when the session id already exists from an earlier process, so the
	 * first run resumes rather than trying to create it.
	 */
	sessionExists?: boolean | undefined;
	/** Called once a run has successfully created the session. */
	onSessionCreated?: (() => void) | undefined;
	/** Called for each reply the agent emits. */
	onOutbound: (message: OutboundMessage) => Promise<void>;
	log?: (message: string, detail?: unknown) => void;
};

/**
 * How an event is presented to the agent. The body is fenced and labelled so
 * that forwarded third-party content reads as data rather than instructions
 * (S2). This is a prompt-level convention, deliberately not a security control.
 */
function formatEvent(event: AgentEvent): string {
	if (event.channel === 'system') {
		// Not owner-originated and has no reply thread: this is the service
		// telling the agent about itself, so it gets no MESSAGE fence.
		return `[system notice]\n${event.text}`;
	}

	const header = event.channel === 'schedule'
		? `[scheduled task: ${event.id}]`
		: `[message via ${event.channel} — reply to thread ${event.threadId}]`;

	const from = event.sender ? `\nfrom: ${event.sender}` : '';

	return `${header}${from}\n<<<MESSAGE\n${event.text}\n MESSAGE`;
}

/** A reply is unrecoverable once dropped, so a transient failure gets retries. */
const SEND_ATTEMPTS = 3;
const SEND_RETRY_MS = 2000;

export class Runner {
	private child: ChildProcessWithoutNullStreams | undefined;

	private activeRun: Promise<void> | undefined;

	/** False until the session has been created by a first run. */
	private started: boolean;

	constructor(private readonly options: RunnerOptions) {
		// A caller that already has a session (e.g. after a service restart)
		// resumes it rather than trying to create it again.
		this.started = options.sessionExists ?? false;
	}

	/** True while a Claude Code invocation is in flight. */
	get isRunning(): boolean {
		return this.child !== undefined;
	}

	/**
	 * Hand an event to the agent. If a run is active the event joins it;
	 * otherwise a new run starts. Resolves when the run this event joined has
	 * finished, so callers can await quiescence.
	 */
	// Deliberately not `async`: the write below must happen synchronously on
	// call, so a batch of events submitted together all reach the same live run
	// instead of trickling in a microtask later.
	// eslint-disable-next-line @typescript-eslint/promise-function-async
	submit(event: AgentEvent): Promise<void> {
		if (this.child) {
			// Joins the run in progress; the idle timer keeps it alive.
			this.write(formatEvent(event));
			return this.activeRun ?? Promise.resolve();
		}

		this.activeRun = this.runWithFallback(formatEvent(event));
		return this.activeRun;
	}

	/** Terminate any in-flight run. Used on shutdown, not on a timeout (O5). */
	stop(): void {
		this.child?.kill('SIGTERM');
		this.child = undefined;
	}

	/**
	 * Runs the event, and retries once on a different model if the first model
	 * declined to answer at all.
	 *
	 * Narrow by design: only a synthetic refusal retries, only once, and only
	 * when a fallback is configured. A crash or an expired token is not worth a
	 * second run, and 'keep trying models until one answers' is not a pattern
	 * worth having — this exists because a model can decline routine traffic,
	 * not to shop around for a permissive one.
	 */
	private async runWithFallback(text: string): Promise<void> {
		const {model, fallbackModel} = this.options;
		const {refused} = await this.startRun(text, model);
		if (!refused || !fallbackModel || fallbackModel === model) {
			if (refused) {
				// Without a fallback the message is simply dropped, so say so
				// rather than leaving the owner wondering why nothing came back.
				this.options.log?.('run refused, no fallback configured', {model});
			}

			return;
		}

		this.options.log?.('run refused, retrying on fallback', {model, fallbackModel});
		const retry = await this.startRun(text, fallbackModel);
		if (retry.refused) {
			this.options.log?.('fallback also refused', {model, fallbackModel});
		}
	}

	private write(text: string): void {
		const message = {
			type: 'user',
			message: {role: 'user', content: [{type: 'text', text}]},
		};
		this.child?.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private async startRun(initialText: string, model: string): Promise<{refused: boolean}> {
		// A session id may only be *created* once: a second process passing
		// --session-id for an existing session exits with "Session ID is already
		// in use". Subsequent runs must --resume it instead. That resumption is
		// what carries context across messages, channels and restarts (F2).
		const sessionArguments = this.started
			? ['--resume', this.options.sessionId]
			: ['--session-id', this.options.sessionId];

		const child = spawn(
			this.options.claudePath ?? 'claude',
			[
				'-p',
				'--input-format',
				'stream-json',
				'--output-format',
				'stream-json',
				'--verbose',
				...sessionArguments,
				// Pinned rather than inherited. --resume keeps whatever model the
				// session started with, so without this the model is decided by
				// whenever the session happened to be created — and silently
				// changes if it is ever recreated.
				'--model',
				model,
				'--append-system-prompt',
				this.options.systemPrompt,
				// `auto` lets Claude Code apply its own judgement about what needs
				// confirming, rather than disabling the check entirely. There is no
				// human at a terminal to approve anything, but that is a reason to
				// keep the model's judgement in the loop, not to remove it.
				'--permission-mode',
				'auto',
			],
			{cwd: this.options.workingDirectory, stdio: 'pipe'},
		);

		this.child = child;
		this.write(initialText);

		const pending: Promise<void>[] = [];
		let refused = false;

		// Claude Code keeps running while stdin is open — that is what allows an
		// event to join a run in progress (F3). So a turn is finished when a
		// `result` message arrives, not when the process exits. We linger briefly
		// afterwards so a message arriving moments later still joins this run,
		// then close stdin to let it shut down.
		const linger = this.options.lingerMs ?? 1500;
		let settleTurn: (() => void) | undefined;
		const turnFinished = new Promise<void>((resolve) => {
			settleTurn = resolve;
		});

		const rl = createInterface({input: child.stdout});
		rl.on('line', (line) => {
			if (!line.trim()) {
				return;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				return;
			}

			if (isRefusal(parsed)) {
				refused = true;
			}

			const text = extractAssistantText(parsed);
			if (text) {
				pending.push(this.emit(text));
			}

			if (isTurnEnd(parsed)) {
				// A run ends after a quiet period rather than on a message count:
				// Claude Code may answer several queued messages in one turn, so
				// results do not map one-to-one onto submissions. Each result
				// restarts the clock, so a follow-up that arrives meanwhile simply
				// extends the run.
				markIdle();
			}
		});

		let idleTimer: NodeJS.Timeout | undefined;
		function markIdle(): void {
			if (idleTimer) {
				clearTimeout(idleTimer);
			}

			idleTimer = setTimeout(() => {
				settleTurn?.();
			}, linger);
		}

		let stderr = '';
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const exited = new Promise<number>((resolve, reject) => {
			child.on('error', reject);
			child.on('close', resolve);
		});

		try {
			// Either the turn completes, or the process dies (crash, or a `-p`
			// mode that exits by itself).
			// turnFinished settles only after `linger` ms of quiet, so a
			// follow-up arriving in the meantime keeps the run alive.
			await Promise.race([turnFinished, exited]);
		} finally {
			if (idleTimer) {
				clearTimeout(idleTimer);
			}

			this.child = undefined;
			this.activeRun = undefined;

			child.stdin.end();
			const code = await exited.catch(() => -1);
			if (code === 0) {
				// Only now is the session known to exist, so later runs resume it.
				if (!this.started) {
					this.started = true;
					this.options.onSessionCreated?.();
				}
			} else {
				this.options.log?.('run exited non-zero', {code, stderr: stderr.slice(0, 2000)});
			}

			rl.close();
			// Replies are dispatched as they stream in; wait for them so callers
			// awaiting the run also see delivery complete.
			await Promise.allSettled(pending);
		}

		return {refused};
	}

	private async emit(text: string): Promise<void> {
		const parsed = parseReply(text);
		if (!parsed) {
			return;
		}

		// Retried, because a reply that fails to send is simply gone — the agent
		// has already said it and will not say it again. One transient error from
		// the bridge (an expired token, a proxy blip) used to cost the whole
		// message, with only a log line to show for it.
		for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
			try {
				// eslint-disable-next-line no-await-in-loop -- attempts are sequential by nature
				await this.options.onOutbound(parsed);
				return;
			} catch (error) {
				this.options.log?.('failed to send reply', {attempt, of: SEND_ATTEMPTS, error});
				if (attempt < SEND_ATTEMPTS) {
					// eslint-disable-next-line no-await-in-loop -- deliberate backoff
					await new Promise((resolve) => {
						setTimeout(resolve, SEND_RETRY_MS * attempt);
					});
				}
			}
		}

		this.options.log?.('giving up on reply, message lost', {text: parsed.text.slice(0, 120)});
	}
}

/** True for the `result` message Claude Code emits when a turn is complete. */
function isTurnEnd(message: unknown): boolean {
	if (typeof message !== 'object' || message === null) {
		return false;
	}

	const record = message as Record<string, unknown>;
	// Newer builds tag it `type: "result"`; older ones emit a bare object
	// carrying `is_error` and `num_turns`.
	return record.type === 'result' || ('is_error' in record && 'num_turns' in record);
}

/**
 * A model declining to answer at all, as opposed to answering badly or the
 * process dying.
 *
 * Claude Code reports this as a synthetic assistant message — the model field
 * is literally `<synthetic>`, because no model produced it. Matching on that
 * pair rather than on the message text keeps it from firing on a crash, an
 * expired token, or a run that simply said something about refusals.
 */
export function isRefusal(message: unknown): boolean {
	if (typeof message !== 'object' || message === null) {
		return false;
	}

	const record = message as Record<string, unknown>;
	if (record.type !== 'assistant') {
		return false;
	}

	const inner = record.message;
	if (typeof inner !== 'object' || inner === null) {
		return false;
	}

	const {stop_reason: stopReason, model} = inner as Record<string, unknown>;
	return stopReason === 'refusal' && model === '<synthetic>';
}

/** Pull assistant prose out of a stream-json line, ignoring tool calls. */
function extractAssistantText(message: unknown): string | undefined {
	if (typeof message !== 'object' || message === null) {
		return undefined;
	}

	const record = message as Record<string, unknown>;
	if (record.type !== 'assistant') {
		return undefined;
	}

	const inner = record.message;
	if (typeof inner !== 'object' || inner === null) {
		return undefined;
	}

	const {content} = (inner as Record<string, unknown>);
	if (!Array.isArray(content)) {
		return undefined;
	}

	const parts = content
		.filter((block): block is {type: 'text'; text: string} => typeof block === 'object'
			&& block !== null
			&& (block as Record<string, unknown>).type === 'text'
			&& typeof (block as Record<string, unknown>).text === 'string')
		.map((block) => block.text.trim())
		.filter((t) => t !== '');

	return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * The agent addresses a reply by prefixing it with a routing line, which the
 * system prompt instructs it to emit:
 *
 *     >>> reply channel=whatsapp thread=44700900000@s.whatsapp.net
 *     the actual message
 *
 * Prose without that prefix is the agent thinking aloud and is not sent, which
 * keeps intermediate narration out of the owner's inbox.
 */
export function parseReply(text: string): OutboundMessage | undefined {
	// The marker is found anywhere in the message, not just at the start: the
	// agent frequently reasons first ("This looks like phishing. Let me reply.")
	// and then emits the routing line. Anchoring to the start silently dropped
	// those replies. Everything before the marker is discarded as thinking.
	const match = /(?:^|\n)>>>[ \t]*reply[ \t]+channel=(\S+)[ \t]+thread=(\S+)[ \t]*\n([\s\S]*)$/.exec(text);
	if (!match?.[1] || !match[2]) {
		return undefined;
	}

	const body = (match[3] ?? '').trim();
	if (body === '') {
		return undefined;
	}

	return {channel: match[1], threadId: match[2], text: body};
}
