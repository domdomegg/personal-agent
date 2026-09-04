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
import type {AgentEvent} from './types.js';

export type RunnerOptions = {
	sessionId: string;
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
	log?: (message: string, detail?: unknown) => void;
};

/**
 * How an event is presented to the agent. The body is fenced and labelled so
 * that forwarded third-party content reads as data rather than instructions
 * (S2). This is a prompt-level convention, deliberately not a security control.
 */
export function formatEvent(event: AgentEvent): string {
	if (event.channel === 'system') {
		// Not owner-originated and has no reply thread: this is the service
		// telling the agent about itself, so it gets no MESSAGE fence.
		return `[system notice]\n${event.text}`;
	}

	const header = event.channel === 'schedule'
		? `[scheduled task: ${event.id}]`
		: `[message via ${event.channel} — reply to thread ${event.threadId}]`;

	const from = event.sender ? `\nfrom: ${event.sender}` : '';

	// The watch note is owner-authored config, not message content, so it sits
	// outside the fence: it is instruction about the data, not part of the data.
	const note = event.note ? `\nowner's note for this watched chat: ${event.note}` : '';

	// Likewise channel-authored: a real attachment is announced here, outside
	// the fence, so a message body merely claiming one stays inert data.
	const attachment = event.attachment ? `\nattachment: ${event.attachment}` : '';

	return `${header}${from}${note}${attachment}\n<<<MESSAGE\n${event.text}\n MESSAGE`;
}

/**
 * How long a wound-down child may keep running — finishing a turn, waiting on
 * a background task — before it is presumed hung and killed. Generous because
 * legitimate background tasks (builds, CI watches) run long; bounded because
 * backlog events wait on the exit, and a child held open forever would leave
 * the runner deaf.
 */
const WIND_DOWN_GRACE_MS = 15 * 60_000;

export class Runner {
	private child: ChildProcessWithoutNullStreams | undefined;

	private activeRun: Promise<void> | undefined;

	/**
	 * True while the current child's stdin is open, i.e. an event can still
	 * join the run by being written to it.
	 */
	private accepting = false;

	/**
	 * Cancels the current run's idle countdown. Set while a run is live, so an
	 * event joining during the linger window keeps the run owned: without this,
	 * the countdown started by the previous result fired mid-message, the
	 * runner tore the run down while the child was still working — dropping its
	 * replies — and the next event spawned a second child resuming the same
	 * session concurrently, forking its context. Seen for real on 2026-08-20.
	 */
	private cancelIdle: (() => void) | undefined;

	/**
	 * Events that arrived after the current child's stdin closed but before it
	 * exited. It cannot take them, and a second child would fork the session,
	 * so they wait here for the next run.
	 */
	private readonly backlog: AgentEvent[] = [];

	/**
	 * Owner messages given to the current run that no reply has yet been
	 * addressed to, keyed by event id. A run is not allowed to wind down while
	 * one of these is unanswered: it gets a reply-check notice first. This is
	 * the guard against the failure of 2026-08-20, where a question joining a
	 * run mid-task was simply never answered — the model finished the task it
	 * was absorbed in, summarised, and the run closed with the message dropped
	 * on the floor.
	 */
	private readonly outstanding = new Map<string, {
		channel: string;
		threadId: string;
		at: string;
		snippet: string;
		nudged: boolean;
	}>();

	/** False until the session has been created by a first run. */
	private started: boolean;

	/**
	 * The model runs actually use: the configured one, until it proves unusable
	 * and runWithFallback switches to the fallback for the rest of the process.
	 */
	private modelOverride: string | undefined;

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
	 * Hand an event to the agent. If a run is accepting input the event joins
	 * it; if one is winding down the event queues for the run after it; only
	 * otherwise does a new run start. Resolves when the run chain this event
	 * joined has finished, so callers can await quiescence.
	 */
	// Deliberately not `async`: the write below must happen synchronously on
	// call, so a batch of events submitted together all reach the same live run
	// instead of trickling in a microtask later.
	// eslint-disable-next-line @typescript-eslint/promise-function-async
	submit(event: AgentEvent): Promise<void> {
		if (this.child) {
			if (this.accepting) {
				// Joins the run in progress. Any idle countdown is cancelled: the
				// turn is live again, and the next result re-arms it.
				this.cancelIdle?.();
				this.dispatch(event);
			} else {
				// The child is winding down: stdin is closed but the process has
				// not exited (it may be finishing a turn, or a background task).
				// Writing is impossible and a second child would fork the session,
				// so the event waits for the run after this one.
				this.backlog.push(event);
			}

			return this.activeRun ?? Promise.resolve();
		}

		this.activeRun = this.runChain(event);
		return this.activeRun;
	}

	/** Terminate any in-flight run. Used on shutdown, not on a timeout (O5). */
	stop(): void {
		this.accepting = false;
		this.child?.kill('SIGTERM');
		this.child = undefined;
	}

	/**
	 * Reports that the agent has sent a message on a thread, settling every
	 * open message there. Called from the channel layer when the agent's own
	 * send comes back around in the poll — the agent sends over MCP itself, so
	 * the echo in the feed is how the runner learns a reply actually happened.
	 * Stronger than trusting the agent's word for it: the echo exists only if
	 * the bridge really accepted the message.
	 */
	noteReplySent(channel: string, threadId: string): void {
		for (const [id, entry] of this.outstanding) {
			if (entry.channel === channel && entry.threadId === threadId) {
				this.outstanding.delete(id);
			}
		}
	}

	/**
	 * Runs the event, then any events that queued while the run was winding
	 * down, until the backlog is empty. One chain owns `activeRun` throughout,
	 * so submit() never starts a second chain while this one lives.
	 */
	private async runChain(initialEvent: AgentEvent): Promise<void> {
		try {
			let events = [initialEvent];
			while (events.length > 0) {
				// eslint-disable-next-line no-await-in-loop -- runs are sequential by design (F4)
				await this.runWithFallback(events);
				events = this.backlog.splice(0);
			}
		} finally {
			this.activeRun = undefined;
		}
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
	private async runWithFallback(events: AgentEvent[]): Promise<void> {
		const {fallbackModel} = this.options;
		const model = this.modelOverride ?? this.options.model;
		const {refused, modelError} = await this.startRun(events, model);

		if (modelError !== undefined && fallbackModel && fallbackModel !== model) {
			// The model cannot be used at all, which repeats identically on every
			// run — so unlike a refusal this switch is sticky. Seen 2026-09-03: a
			// self-restart came back on the image's older Claude Code, which
			// rejected the newly configured model id with a 400, and every run
			// died the same way for 16 hours until Adam rebuilt the image. The
			// fallback run carries a notice so the agent tells the owner and can
			// fix the cause itself instead of sitting dead.
			this.modelOverride = fallbackModel;
			this.options.log?.('model unusable, running on fallback until restart', {model, fallbackModel, error: modelError});
			const notice: AgentEvent = {
				id: `model-fallback-${Date.now()}`,
				channel: 'system',
				threadId: '',
				text: `The configured model ${model} cannot be used: the previous run failed with "${modelError}". This run and every later run use the fallback model ${fallbackModel} until the service restarts. Tell the owner, and fix the cause (the model in agent.config.json, or the Claude Code version in the image) before restarting.`,
				timestamp: new Date(),
			};
			const retry = await this.startRun([notice, ...events], fallbackModel);
			if (retry.modelError !== undefined) {
				this.options.log?.('fallback model also unusable', {fallbackModel, error: retry.modelError});
			}

			return;
		}

		if (!refused || !fallbackModel || fallbackModel === model) {
			if (refused) {
				// Without a fallback the message is simply dropped, so say so
				// rather than leaving the owner wondering why nothing came back.
				this.options.log?.('run refused, no fallback configured', {model});
			}

			return;
		}

		this.options.log?.('run refused, retrying on fallback', {model, fallbackModel});
		const retry = await this.startRun(events, fallbackModel);
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

	/**
	 * Write an event into the live child, and if it is the kind of message that
	 * deserves an answer, remember that it has not had one yet. Scheduled
	 * firings and system notices carry no expectant human; watched-chat
	 * messages are heard, not conversed with, so none of those are tracked.
	 */
	private dispatch(event: AgentEvent): void {
		this.write(formatEvent(event));
		if (event.channel !== 'system' && event.channel !== 'schedule' && !event.note) {
			this.outstanding.set(event.id, {
				channel: event.channel,
				threadId: event.threadId,
				at: event.timestamp.toISOString(),
				// A captionless attachment has no text to quote; name the media
				// instead so the reply-check does not present an empty message.
				snippet: event.text.trim() === '' && event.attachment
					? `[${event.attachment.slice(0, 120)}]`
					: event.text.slice(0, 140),
				nudged: false,
			});
		}
	}

	private async startRun(initialEvents: AgentEvent[], model: string): Promise<{refused: boolean; modelError?: string | undefined}> {
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
		this.accepting = true;
		// Whatever an earlier run left unanswered was already nudged about and
		// logged; carrying it into this run would nag about stale traffic.
		this.outstanding.clear();
		for (const event of initialEvents) {
			this.dispatch(event);
		}

		let refused = false;
		let modelError: string | undefined;
		let compactRequested = false;
		let justCompacted = false;

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

			modelError ??= modelUnusableError(parsed);

			// The agent sends its own messages over MCP; assistant text is only
			// scanned for directives to the harness, never delivered anywhere.
			const text = extractAssistantText(parsed);
			if (text && wantsCompact(text)) {
				compactRequested = true;
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
		// Guards against a countdown that already expired when it was cancelled:
		// clearTimeout on a fired timer is a no-op, its callback is queued and
		// runs anyway, and would nudge about — or wind down past — a message
		// that joined the run in the same beat. A stale epoch aborts it instead.
		let idleEpoch = 0;
		const markIdle = (): void => {
			idleEpoch += 1;
			const epoch = idleEpoch;
			if (idleTimer) {
				clearTimeout(idleTimer);
			}

			idleTimer = setTimeout(() => {
				if (epoch !== idleEpoch) {
					return;
				}

				// A message that never got a reply blocks the wind-down, once: the
				// agent absorbed in a task can finish its turn without answering a
				// question that joined mid-run, and by then the human is staring at
				// silence. The check lives here — not at result time — because a
				// turn may legitimately end several times before the reply comes.
				// One nudge per message, so a deliberate non-reply (stated to the
				// notice) lets the run close rather than looping forever.
				const unanswered = [...this.outstanding.values()].filter((entry) => !entry.nudged);
				if (unanswered.length > 0) {
					for (const entry of unanswered) {
						entry.nudged = true;
					}

					this.options.log?.('nudging: messages without replies', {count: unanswered.length});
					// "No reply seen" means no echo of an agent send has come back
					// on that thread yet. The check can fire while a send is still
					// propagating (echoes arrive via the next poll), so the
					// wording allows "already handled" rather than presuming
					// neglect.
					this.write([
						'[system notice]',
						'Reply check — no reply has been seen for these messages this run:',
						...unanswered.map((entry) => `- ${entry.channel} thread ${entry.threadId} at ${entry.at}: "${entry.snippet}"`),
						'Reply to each now by calling the channel\'s send tool. If one is already handled or genuinely needs no reply, say so explicitly and finish.',
					].join('\n'));
					// Not settling: the notice produces its own turn end, which
					// re-arms this timer — by then the replies should be through.
					return;
				}

				// Compaction is deliberately deferred to here rather than run the
				// moment the directive is seen. Mid-turn it would be queued behind
				// the work in progress and land in the middle of it, which is the
				// ambush the directive exists to avoid: the point of asking is to
				// compact at a chosen moment, not merely to compact.
				if (compactRequested) {
					compactRequested = false;
					justCompacted = true;
					this.options.log?.('compacting on request');
					// Sent raw, not through write(), so it reaches Claude Code as a
					// slash command. Everything else goes through formatEvent's
					// fence precisely so it cannot do this.
					this.write('/compact');
					// Not settling: the compaction produces its own turn end, which
					// re-arms this timer with the flag now clear.
					return;
				}

				// A requested compaction lands between turns, and the continuation
				// prompt Claude Code then issues is wrapped in a "do not respond"
				// local-command caveat. Seen once (2026-08-23): the agent obeyed the
				// caveat, answered nothing, and the run wound down with its planned
				// work dropped. So after the compact settles, prompt the resume
				// explicitly through the normal channel.
				if (justCompacted) {
					justCompacted = false;
					this.options.log?.('post-compact resume notice');
					this.write([
						'[system notice]',
						'Context compaction (your >>> compact) is done. If any planned or in-progress work remains, pick it up now. If you already resumed, or nothing is pending, say so explicitly and finish.',
					].join('\n'));
					// Not settling: the notice's own turn end re-arms this timer.
					return;
				}

				// The quiet period has passed with no event joining, so the run
				// winds down. stdin closes here — in the same tick the flag flips —
				// so a submit() racing this callback either cancelled the timer
				// first or sees `accepting` false and queues for the next run.
				this.accepting = false;
				child.stdin.end();
				settleTurn?.();
			}, linger);
		};

		// An event joining the run cancels the countdown: the turn is live again,
		// and the result it eventually produces re-arms the timer via markIdle.
		this.cancelIdle = () => {
			idleEpoch += 1;
			if (idleTimer) {
				clearTimeout(idleTimer);
				idleTimer = undefined;
			}
		};

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
			this.cancelIdle?.();
			this.cancelIdle = undefined;

			// The idle path has already closed stdin; this is for the crash path.
			if (this.accepting) {
				this.accepting = false;
				child.stdin.end();
			}

			// The child stays owned until it actually exits: after stdin closes it
			// may still be finishing a turn or waiting on a background task, and
			// its output — task-notification turns included — must keep being
			// read. Releasing it at turn end instead let a new event spawn a
			// second child resuming the same session concurrently.
			//
			// Bounded, because backlog events wait on this exit: a child held open
			// by a hung call would otherwise leave the runner deaf for good. The
			// grace is generous since legitimate background tasks (builds, CI
			// watches) can run long.
			const graceTimer = setTimeout(() => {
				this.options.log?.('child still alive after wind-down grace, killing', {model});
				child.kill('SIGTERM');
			}, WIND_DOWN_GRACE_MS);
			const code = await exited.catch(() => -1);
			clearTimeout(graceTimer);
			this.child = undefined;

			if (code === 0) {
				// Only now is the session known to exist, so later runs resume it.
				if (!this.started) {
					this.started = true;
					this.options.onSessionCreated?.();
				}
			} else {
				this.options.log?.('run exited non-zero', {code, stderr: stderr.slice(0, 2000)});
			}

			// A message still open after its nudge was consciously left unanswered
			// or genuinely dropped; either way it should be visible in the logs
			// rather than silently forgotten when the next run clears the slate.
			if (this.outstanding.size > 0) {
				this.options.log?.('run ended with unanswered messages', [...this.outstanding.values()]);
			}

			rl.close();
		}

		return {refused, modelError};
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

/**
 * The model cannot be used at all, as opposed to declining (isRefusal) or a
 * transient failure. Claude Code relays the API's rejection as a synthetic
 * assistant message whose text begins "API Error: 400 ..." — e.g. "Claude Code
 * 2.1.241 does not support this model", or a 404 for an unknown model id.
 * Returns the error text, or undefined.
 *
 * Deliberately only 400/404 that mention the model: auth failures, rate
 * limits and overloads are not the model's fault, and switching models on
 * those would be shopping around rather than recovering.
 */
export function modelUnusableError(message: unknown): string | undefined {
	const text = extractAssistantText(message);
	if (text === undefined) {
		return undefined;
	}

	const inner = (message as {message: Record<string, unknown>}).message;
	if (inner.model !== '<synthetic>') {
		return undefined;
	}

	return /^API Error: (?:400|404)\b[^\n]*\bmodel\b/i.test(text) ? text.split('\n')[0] : undefined;
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
 * The agent asks for its own context to be compacted by emitting a bare
 * directive on its own line:
 *
 *     >>> compact
 *
 * Claude Code compacts on a context-size threshold by itself, so this is not
 * about avoiding overflow. It is about *when*: an automatic compaction lands
 * wherever the threshold happens to fall, often mid-task, whereas the agent
 * knows when it has just finished something and is holding nothing it needs.
 *
 * Note this cannot be triggered by an incoming message, since every event body
 * is wrapped by formatEvent and so never reaches Claude Code with a leading
 * slash. Only the agent's own output is scanned for the directive.
 */
export function wantsCompact(text: string): boolean {
	return /(?:^|\n)>>>[ \t]*compact[ \t]*(?:\n|$)/.test(text);
}

