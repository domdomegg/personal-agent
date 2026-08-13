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
	/** IANA zone the cron expressions are evaluated in; system zone if unset. */
	timezone?: string | undefined;
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
			if (!matches(entry.cron, now, this.options.timezone)) {
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
 *
 * Evaluated against the wall clock of `timezone` when given, so "0 9 * * *"
 * means 9am where the owner lives, not 9am in whatever zone the container
 * happens to run (usually UTC — an hour off for most of the year in the UK).
 */
export function matches(expression: string, date: Date, timezone?: string): boolean {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) {
		return false;
	}

	const values = timezone
		? zonedValues(date, timezone)
		: [
			date.getMinutes(),
			date.getHours(),
			date.getDate(),
			date.getMonth() + 1,
			date.getDay(),
		];

	return fields.every((field, index) => fieldMatches(field, values[index] ?? 0));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The cron field values for `date` as seen on a clock in `timezone`. */
function zonedValues(date: Date, timezone: string): number[] {
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone: timezone,
		minute: 'numeric',
		hour: 'numeric',
		hourCycle: 'h23',
		day: 'numeric',
		month: 'numeric',
		weekday: 'short',
	}).formatToParts(date);

	const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';

	return [
		Number.parseInt(get('minute'), 10),
		Number.parseInt(get('hour'), 10),
		Number.parseInt(get('day'), 10),
		Number.parseInt(get('month'), 10),
		WEEKDAYS.indexOf(get('weekday')),
	];
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
