import {test, expect, vi} from 'vitest';
import {createWebChannel, WEB_CHANNEL_ID, WEB_THREAD_ID} from './web.js';

test('a received message comes out of the next poll, once', async () => {
	const web = createWebChannel();
	const id = web.receive('hello');

	const events = await web.poll();
	expect(events).toEqual([expect.objectContaining({
		id, channel: WEB_CHANNEL_ID, threadId: WEB_THREAD_ID, text: 'hello',
	})]);
	expect(await web.poll()).toEqual([]);
});

test('every message gets its own id, so the dispatcher never drops one as a duplicate', async () => {
	const web = createWebChannel();
	web.receive('same');
	web.receive('same');

	const [first, second] = await web.poll();
	expect(first?.id).not.toBe(second?.id);
});

test('noteSent reports the reply so the runner\'s reply-check stands down', () => {
	const onSent = vi.fn();
	createWebChannel({onSent}).noteSent();
	expect(onSent).toHaveBeenCalledOnce();
});

test('a harness-side send fails loudly rather than vanishing', async () => {
	await expect(createWebChannel().send({channel: WEB_CHANNEL_ID, threadId: WEB_THREAD_ID, text: 'x'}))
		.rejects.toThrow(/send_message/);
});
