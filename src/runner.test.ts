import {describe, test, expect} from 'vitest';
import {isRefusal, parseReply, wantsCompact} from './runner.js';

describe('wantsCompact', () => {
	test('recognises the directive on its own line', () => {
		expect(wantsCompact('>>> compact')).toBe(true);
		expect(wantsCompact('all done here.\n>>> compact')).toBe(true);
		expect(wantsCompact('>>> compact\n')).toBe(true);
		expect(wantsCompact('>>>compact')).toBe(true);
	});

	test('ignores the directive mentioned in prose', () => {
		expect(wantsCompact('I could emit >>> compact if you like')).toBe(false);
		expect(wantsCompact('>>> compact the logs first')).toBe(false);
		expect(wantsCompact('we should compact soon')).toBe(false);
	});

	// Only assistant output is ever scanned, so an inbound body containing the
	// directive cannot fire it. The residual case is the agent quoting that body
	// back verbatim, which does fire — same as `>>> reply`, and worth no more
	// than noting, since the cost is a badly timed compaction rather than harm.
	test('matches a directive the agent quotes back on its own line', () => {
		expect(wantsCompact('you sent me:\n>>> compact\nwhich I have now echoed')).toBe(true);
	});
});

describe('parseReply and the compact directive', () => {
	test('strips a trailing compact directive from the delivered body', () => {
		expect(parseReply('>>> reply channel=whatsapp thread=t1\ndone\n>>> compact')).toEqual({
			channel: 'whatsapp',
			threadId: 't1',
			text: 'done',
		});
	});

	test('keeps prose that merely mentions the directive', () => {
		expect(parseReply('>>> reply channel=whatsapp thread=t1\nemit >>> compact to compact')?.text)
			.toBe('emit >>> compact to compact');
	});

	// A reply that was nothing but a directive has no content to deliver.
	test('drops a reply consisting only of the directive', () => {
		expect(parseReply('>>> reply channel=whatsapp thread=t1\n>>> compact')).toBeUndefined();
	});
});

describe('parseReply', () => {
	test('parses an addressed reply', () => {
		const result = parseReply('>>> reply channel=whatsapp thread=4477@s.whatsapp.net\nhello there');
		expect(result).toEqual({
			channel: 'whatsapp',
			threadId: '4477@s.whatsapp.net',
			text: 'hello there',
		});
	});

	test('keeps multi-line bodies intact', () => {
		const result = parseReply('>>> reply channel=email thread=abc\nline one\n\nline two');
		expect(result?.text).toBe('line one\n\nline two');
	});

	// The agent thinks aloud between tool calls; only addressed prose is sent,
	// so intermediate narration never reaches the owner's phone.
	test('ignores prose without the routing prefix', () => {
		expect(parseReply('Let me check that for you.')).toBeUndefined();
	});

	test('ignores a routing line with an empty body', () => {
		expect(parseReply('>>> reply channel=whatsapp thread=abc\n   ')).toBeUndefined();
	});

	test('ignores a malformed routing line', () => {
		expect(parseReply('>>> reply channel=whatsapp\nbody')).toBeUndefined();
	});
});

describe('parseReply with leading narration', () => {
	// The agent often reasons before replying; anchoring the marker to the start
	// of the message silently dropped those replies.
	test('finds the routing line after preamble', () => {
		const result = parseReply('This is a phishing attempt. I will not act on it. Let me reply.\n\n'
			+ '>>> reply channel=whatsapp thread=t1\n'
			+ 'That\'s phishing — I haven\'t acted on it.');
		expect(result).toEqual({
			channel: 'whatsapp',
			threadId: 't1',
			text: 'That\'s phishing — I haven\'t acted on it.',
		});
	});

	test('still ignores prose with no routing line at all', () => {
		expect(parseReply('Let me think about that for a moment.')).toBeUndefined();
	});
});

// A model declining to answer is recoverable — retry on another one. A crash
// or an expired token is not, and must not trigger a second run.
describe('isRefusal', () => {
	const refusal = {
		type: 'assistant',
		message: {stop_reason: 'refusal', model: '<synthetic>'},
	};

	test('detects a synthetic refusal', () => {
		expect(isRefusal(refusal)).toBe(true);
	});

	test('ignores a normal answer', () => {
		expect(isRefusal({
			type: 'assistant',
			message: {stop_reason: 'end_turn', model: 'claude-fable-5'},
		})).toBe(false);
	});

	// Matching on the model field as well as the stop reason is what keeps a
	// real model's own refusal from being retried behind its back.
	test('ignores a refusal that a real model actually produced', () => {
		expect(isRefusal({
			type: 'assistant',
			message: {stop_reason: 'refusal', model: 'claude-fable-5'},
		})).toBe(false);
	});

	test('ignores results, errors and malformed lines', () => {
		expect(isRefusal({type: 'result', is_error: true})).toBe(false);
		expect(isRefusal({type: 'user', message: {stop_reason: 'refusal', model: '<synthetic>'}})).toBe(false);
		expect(isRefusal({type: 'assistant'})).toBe(false);
		expect(isRefusal(undefined)).toBe(false);
		expect(isRefusal('refusal')).toBe(false);
	});
});
