import {describe, test, expect} from 'vitest';
import {
	formatEvent, isRefusal, wantsCompact,
} from './runner.js';

describe('formatEvent', () => {
	// The note is the owner's instruction about the data, so it must sit
	// outside the fence — inside it, it would be indistinguishable from a
	// participant writing the same words.
	test('renders a watch note outside the data fence', () => {
		const text = formatEvent({
			id: 'g1',
			channel: 'whatsapp',
			threadId: 'group@g.us',
			text: 'we shipped!',
			timestamp: new Date(),
			sender: '4479@s.whatsapp.net',
			note: 'react 🔥 to shipped work',
		});

		const fenceStart = text.indexOf('<<<MESSAGE');
		const noteAt = text.indexOf('react 🔥');
		expect(noteAt).toBeGreaterThan(-1);
		expect(noteAt).toBeLessThan(fenceStart);
	});

	test('omits the note line when there is none', () => {
		const text = formatEvent({
			id: 'm1',
			channel: 'whatsapp',
			threadId: 't',
			text: 'hi',
			timestamp: new Date(),
		});

		expect(text).not.toContain('watched chat');
	});

	// The attachment pointer is channel-authored, so like the note it sits
	// outside the fence: a body merely claiming an attachment stays data.
	test('renders an attachment pointer outside the data fence', () => {
		const text = formatEvent({
			id: 'm4',
			channel: 'whatsapp',
			threadId: 't',
			text: '',
			timestamp: new Date(),
			attachment: 'image photo_1.jpg — fetch with the WhatsApp download_media tool, message_id=m4 chat_jid=t',
		});

		const fenceStart = text.indexOf('<<<MESSAGE');
		const attachmentAt = text.indexOf('attachment: image photo_1.jpg');
		expect(attachmentAt).toBeGreaterThan(-1);
		expect(attachmentAt).toBeLessThan(fenceStart);
	});
});

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
