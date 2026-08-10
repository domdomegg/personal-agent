/**
 * Polls channels, deduplicates, and feeds the runner.
 *
 * Claude Code is invoked only when there is a real event (O3): an empty poll
 * costs a couple of MCP calls and nothing else.
 *
 * Deduplication is by event id, persisted to a small JSON file so that a
 * restart neither loses nor replays anything (F5, F6). Channels additionally
 * keep their own cursors; this is the backstop for the gap between "fetched"
 * and "finished with".
 */
import {
	readFileSync, writeFileSync, renameSync, existsSync,
} from 'node:fs';
import type {AgentEvent, Channel, Config} from './types.js';
import type {Runner} from './runner.js';

/** Keeps the state file bounded; far larger than any plausible backlog. */
const MAX_REMEMBERED_IDS = 5000;

/**
 * Consecutive poll failures on one channel before the agent is told about it.
 *
 * A count rather than a duration, so it has to be read against the poll
 * interval: at the current ~1s cadence (plus ~1.7s of proxy latency per call)
 * this is roughly three minutes of continuous failure. Being unreachable for a
 * minute or two is unremarkable and should stay silent.
 */
const POLL_FAILURES_BEFORE_ALERT = 60;

/**
 * Alerts fire at 60, 120, 240, 480... consecutive failures — doubling, so a
 * persistent outage keeps nagging without waking the agent every few minutes
 * for hours. Tripling from a threshold this size would jump straight from
 * ~3 minutes to ~9, which is too coarse to be useful.
 */
function isAlertThreshold(failures: number): boolean {
	let threshold = POLL_FAILURES_BEFORE_ALERT;
	while (threshold < failures) {
		threshold *= 2;
	}

	return threshold === failures;
}

export type DispatcherOptions = {
	channels: Channel[];
	runner: Pick<Runner, 'submit'>;
	statePath: string;
	polling: Config['polling'];
	log?: (message: string, detail?: unknown) => void;
};

export class Dispatcher {
	private readonly seen: Set<string>;

	private readonly cursors: Map<string, string>;

	private lastActivity = 0;

	/** Consecutive poll failures per channel; cleared by any successful poll. */
	private readonly pollFailures = new Map<string, number>();

	private stopped = false;

	private timer: NodeJS.Timeout | undefined;

	constructor(private readonly options: DispatcherOptions) {
		const {seen, cursors} = readState(options.statePath);
		this.seen = seen;
		this.cursors = cursors;
	}

	/** Channels persist their poll position through these. */
	getCursor(channel: string): string | undefined {
		return this.cursors.get(channel);
	}

	setCursor(channel: string, cursor: string): void {
		this.cursors.set(channel, cursor);
		this.persist();
	}

	/** True if this event has already been handed to the agent. */
	hasSeen(id: string): boolean {
		return this.seen.has(id);
	}

	markSeen(id: string): void {
		this.seen.add(id);
		this.persist();
	}

	start(): void {
		this.stopped = false;
		this.scheduleNext(0);
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * One poll of every channel, dispatching anything new. Exposed so tests can
	 * drive the loop deterministically rather than waiting on timers.
	 */
	async tick(): Promise<void> {
		const results = await Promise.allSettled(this.options.channels.map(async (channel) => channel.poll()));

		const fresh: AgentEvent[] = [];
		// Only genuine channel traffic, so the synthetic poll-failure alerts
		// pushed into `fresh` below are never sent back as read receipts.
		const toAcknowledge = new Map<Channel, AgentEvent[]>();
		for (const [index, result] of results.entries()) {
			const channelId = this.options.channels[index]?.id ?? `channel-${index}`;

			if (result.status === 'rejected') {
				this.options.log?.('poll failed', {
					channel: channelId,
					error: result.reason,
				});

				const alert = this.recordPollFailure(channelId, result.reason);
				if (alert) {
					fresh.push(alert);
				}

				continue;
			}

			// A poll that came back at all clears the streak, even if empty: the
			// channel is reachable, which is what the counter tracks.
			this.pollFailures.delete(channelId);

			for (const event of result.value) {
				if (this.seen.has(event.id)) {
					continue;
				}

				// Marked before dispatch: at-most-once. Re-handling an event the
				// agent may already have acted on is the worse failure, since
				// actions are not generally idempotent.
				this.markSeen(event.id);
				fresh.push(event);

				const channel = this.options.channels[index];
				if (channel?.markRead) {
					const pending = toAcknowledge.get(channel) ?? [];
					pending.push(event);
					toAcknowledge.set(channel, pending);
				}
			}
		}

		if (fresh.length === 0) {
			return;
		}

		this.lastActivity = Date.now();
		fresh.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

		// Submit all of them in one synchronous pass. The first starts a run; the
		// rest join it while it is live (F3). Awaiting each in turn would instead
		// let the run finish between messages, so a rapid follow-up would arrive
		// at a process already shutting down.
		//
		// Deliberately not awaited: submit() resolves only when the whole run
		// ends, so awaiting here would stall the poll loop for the duration of a
		// run (scheduleNext only fires after tick resolves). Messages sent while
		// the agent was working then sat unfetched on the bridge until the run
		// finished — they appeared to arrive late, or only once a later message
		// happened to land inside a live run. Polling must stay independent of
		// run length so mid-run messages are picked up and join the live run.
		for (const event of fresh) {
			this.options.log?.('dispatching', {id: event.id, channel: event.channel});
			void this.options.runner.submit(event).catch((error: unknown) => {
				this.options.log?.('run failed', {id: event.id, error});
			});
		}

		// After dispatch, so a receipt means the agent has the message. Not
		// awaited, for the same reason submit() is not: the poll loop must not
		// stall on a network round-trip to the bridge.
		for (const [channel, events] of toAcknowledge) {
			void channel.markRead?.(events).catch((error: unknown) => {
				this.options.log?.('failed to mark read', {channel: channel.id, error});
			});
		}
	}

	/**
	 * Counts a failed poll and, at the backoff thresholds, returns an event that
	 * wakes the agent to investigate.
	 *
	 * Waking the agent is deliberately preferred over messaging the owner
	 * directly: the reply path runs through the same MCP bridge as polling, so
	 * whatever broke the poll has probably broken the send too. The agent can
	 * diagnose, and starting a run tends to refresh the credentials whose expiry
	 * is the most common cause. It decides whether to tell the owner.
	 */
	private recordPollFailure(channelId: string, reason: unknown): AgentEvent | undefined {
		const failures = (this.pollFailures.get(channelId) ?? 0) + 1;
		this.pollFailures.set(channelId, failures);

		if (!isAlertThreshold(failures)) {
			return undefined;
		}

		// Id encodes the count, so each threshold is a distinct event that
		// survives the seen-set; the outage cannot alert twice for one threshold.
		const id = `poll-failure:${channelId}:${failures}`;
		if (this.seen.has(id)) {
			return undefined;
		}

		this.markSeen(id);
		this.options.log?.('poll failure alert', {channel: channelId, failures});

		return {
			id,
			channel: 'system',
			threadId: 'system',
			text: `Polling the ${channelId} channel has failed ${failures} times in a row, so you `
				+ 'may be missing messages. The most recent error was:\n\n'
				+ `${describeError(reason)}\n\n`
				+ 'Investigate and fix it if you can. A common cause is an expired '
				+ 'Claude Code token used by call-mcp, which running `claude` once '
				+ 'refreshes. Only message Adam if you need him to act, bearing in '
				+ 'mind the reply path may be broken too.',
			timestamp: new Date(),
		};
	}

	/** Fast cadence just after activity, slow when quiet. */
	private currentInterval(): number {
		const {idleIntervalMs, activeIntervalMs, activeWindowMs} = this.options.polling;
		return Date.now() - this.lastActivity < activeWindowMs ? activeIntervalMs : idleIntervalMs;
	}

	private scheduleNext(delayMs: number): void {
		if (this.stopped) {
			return;
		}

		this.timer = setTimeout(() => {
			void (async () => {
				try {
					await this.tick();
				} catch (error) {
					this.options.log?.('tick failed', error);
				}

				this.scheduleNext(this.currentInterval());
			})();
		}, delayMs);
	}

	private persist(): void {
		// Trim oldest first; Set preserves insertion order.
		const ids = [...this.seen];
		const kept = ids.length > MAX_REMEMBERED_IDS ? ids.slice(-MAX_REMEMBERED_IDS) : ids;
		if (kept.length !== ids.length) {
			this.seen.clear();
			for (const id of kept) {
				this.seen.add(id);
			}
		}

		const snapshot = {
			seenEventIds: kept,
			cursors: Object.fromEntries(this.cursors),
		};

		// Write-then-rename so a crash mid-write cannot truncate the file.
		const temporary = `${this.options.statePath}.tmp`;
		writeFileSync(temporary, JSON.stringify(snapshot, undefined, '\t'));
		renameSync(temporary, this.options.statePath);
	}
}

/**
 * Renders a rejection for the agent to read. Errors from the MCP bridge carry
 * the useful detail on stdout rather than in the message, so include it.
 */
function describeError(reason: unknown): string {
	if (!(reason instanceof Error)) {
		return String(reason);
	}

	const {stdout} = reason as Error & {stdout?: unknown};
	const detail = typeof stdout === 'string' && stdout.trim().length > 0
		? `\n${stdout.trim()}`
		: '';

	return `${reason.message}${detail}`;
}

function readState(path: string): {seen: Set<string>; cursors: Map<string, string>} {
	if (!existsSync(path)) {
		return {seen: new Set(), cursors: new Map()};
	}

	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
			seenEventIds?: string[];
			cursors?: Record<string, string>;
		};
		return {
			seen: new Set(parsed.seenEventIds ?? []),
			cursors: new Map(Object.entries(parsed.cursors ?? {})),
		};
	} catch {
		// A corrupt state file must not stop the service coming up. Worst case we
		// re-handle recent events, which is better than being dead.
		return {seen: new Set(), cursors: new Map()};
	}
}
