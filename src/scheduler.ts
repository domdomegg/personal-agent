/**
 * Cron scheduling, without a dependency.
 *
 * Checks once a minute whether any entry matches the current wall-clock minute.
 * A firing produces an event id containing the minute, so a restart within the
 * same minute cannot double-fire (the dispatcher deduplicates on event id).
 */
import type {AgentEvent, ScheduleEntry} from './types.js';

export type SchedulerOptions = {
	entries: ScheduleEntry[];
	onFire: (event: AgentEvent) => Promise<void>;
	log?: (message: string, detail?: unknown) => void;
};

export const SCHEDULE_CHANNEL_ID = 'schedule';

export class Scheduler {
	private timer: NodeJS.Timeout | undefined;

	constructor(private readonly options: SchedulerOptions) {}

	start(): void {
		this.stop();
		// Align to the top of the next minute, then tick every minute.
		const msToNextMinute = 60_000 - (Date.now() % 60_000);
		this.timer = setTimeout(() => {
			void this.fireDue(new Date());
			this.timer = setInterval(() => {
				void this.fireDue(new Date());
			}, 60_000);
		}, msToNextMinute);
	}

	stop(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** Fire every entry matching `now`. Exposed for tests. */
	async fireDue(now: Date): Promise<void> {
		for (const entry of this.options.entries) {
			if (!matches(entry.cron, now)) {
				continue;
			}

			const event: AgentEvent = {
				id: `schedule:${entry.id}:${minuteKey(now)}`,
				channel: SCHEDULE_CHANNEL_ID,
				threadId: entry.id,
				text: entry.prompt,
				timestamp: now,
			};

			try {
				// eslint-disable-next-line no-await-in-loop
				await this.options.onFire(event);
			} catch (error) {
				this.options.log?.('scheduled entry failed', {id: entry.id, error});
			}
		}
	}
}

function minuteKey(date: Date): string {
	return date.toISOString().slice(0, 16);
}

/**
 * Standard 5-field cron: minute hour day-of-month month day-of-week.
 * Supports wildcards, lists (`1,2`), ranges (`1-5`), and step values.
 */
export function matches(expression: string, date: Date): boolean {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) {
		return false;
	}

	const values = [
		date.getMinutes(),
		date.getHours(),
		date.getDate(),
		date.getMonth() + 1,
		date.getDay(),
	];

	return fields.every((field, index) => fieldMatches(field, values[index] ?? 0));
}

function fieldMatches(field: string, value: number): boolean {
	return field.split(',').some((part) => {
		const [range, stepRaw] = part.split('/');
		const step = stepRaw ? Number.parseInt(stepRaw, 10) : 1;
		if (Number.isNaN(step) || step < 1) {
			return false;
		}

		if (range === '*' || range === undefined) {
			return value % step === 0;
		}

		if (range.includes('-')) {
			const [startRaw, endRaw] = range.split('-');
			const start = Number.parseInt(startRaw ?? '', 10);
			const end = Number.parseInt(endRaw ?? '', 10);
			if (Number.isNaN(start) || Number.isNaN(end)) {
				return false;
			}

			return value >= start && value <= end && (value - start) % step === 0;
		}

		const exact = Number.parseInt(range, 10);
		return !Number.isNaN(exact) && exact === value;
	});
}
