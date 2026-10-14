import {test, expect, vi} from 'vitest';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
	createWebChannel({onSent}).noteSent('hi');
	expect(onSent).toHaveBeenCalledOnce();
});

test('noteSent keeps the reply text under the id it returns, so the viewer need not parse the shell', () => {
	const web = createWebChannel();
	const id = web.noteSent('it\'s "quoted" & odd');
	expect(id).toMatch(/^web-reply-/);
	expect(web.replyText(id)).toBe('it\'s "quoted" & odd');
	expect(web.replyText('web-reply-unknown')).toBeUndefined();
});

test('reply texts persist across a restart when a store path is given', () => {
	const storePath = join(mkdtempSync(join(tmpdir(), 'web-test-')), 'web-replies.jsonl');
	const id = createWebChannel({storePath}).noteSent('remember me');

	expect(createWebChannel({storePath}).replyText(id)).toBe('remember me');
});

test('a harness-side send fails loudly rather than vanishing', async () => {
	await expect(createWebChannel().send({channel: WEB_CHANNEL_ID, threadId: WEB_THREAD_ID, text: 'x'}))
		.rejects.toThrow(/send_message/);
});
