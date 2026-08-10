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
});
