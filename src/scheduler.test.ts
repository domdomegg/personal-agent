import {describe, test, expect} from 'vitest';
import {matches} from './scheduler.js';

// 2026-08-06 is a Thursday (day 4).
const thursday0900 = new Date(2026, 7, 6, 9, 0);
const thursday0905 = new Date(2026, 7, 6, 9, 5);

describe('cron matching', () => {
	test('every minute', () => {
		expect(matches('* * * * *', thursday0900)).toBe(true);
	});

	test('exact minute and hour', () => {
		expect(matches('0 9 * * *', thursday0900)).toBe(true);
		expect(matches('0 9 * * *', thursday0905)).toBe(false);
	});

	test('step values', () => {
		expect(matches('*/5 * * * *', thursday0905)).toBe(true);
		expect(matches('*/5 * * * *', new Date(2026, 7, 6, 9, 7))).toBe(false);
	});

	test('lists', () => {
		expect(matches('0,5 9 * * *', thursday0905)).toBe(true);
		expect(matches('0,5 9 * * *', new Date(2026, 7, 6, 9, 6))).toBe(false);
	});

	test('ranges', () => {
		expect(matches('0 8-10 * * *', thursday0900)).toBe(true);
		expect(matches('0 10-12 * * *', thursday0900)).toBe(false);
	});

	test('day of week', () => {
		expect(matches('0 9 * * 4', thursday0900)).toBe(true);
		expect(matches('0 9 * * 1', thursday0900)).toBe(false);
	});

	test('malformed expressions never match', () => {
		expect(matches('nonsense', thursday0900)).toBe(false);
		expect(matches('* * *', thursday0900)).toBe(false);
	});

	// The container runs UTC, so without this a 9am briefing arrives at 10am
	// for half the year.
	describe('timezone', () => {
		// 08:00 UTC in British Summer Time is 09:00 on the owner's clock.
		const bst0800utc = new Date('2026-07-02T08:00:00Z');
		// ...and in winter the two clocks agree.
		const gmt0900utc = new Date('2026-01-02T09:00:00Z');

		test('evaluates the cron on the configured zone\'s wall clock', () => {
			expect(matches('0 9 * * *', bst0800utc, 'Europe/London')).toBe(true);
			expect(matches('0 8 * * *', bst0800utc, 'Europe/London')).toBe(false);
			expect(matches('0 9 * * *', gmt0900utc, 'Europe/London')).toBe(true);
		});

		test('weekday follows the zone, not UTC', () => {
			// 23:30 UTC on Friday is 08:30 Saturday in Tokyo.
			const fridayLateUtc = new Date('2026-07-03T23:30:00Z');
			expect(matches('30 8 * * 6', fridayLateUtc, 'Asia/Tokyo')).toBe(true);
			expect(matches('30 23 * * 5', fridayLateUtc, 'Asia/Tokyo')).toBe(false);
		});

		test('without a zone the system clock is used, as before', () => {
			expect(matches('0 9 * * 4', thursday0900)).toBe(true);
		});
	});
});
