import {describe, test, expect} from 'vitest';
import {createWhatsappChannel} from './whatsapp.js';
import type {McpCaller} from '../mcp.js';

const OWNER = '441234567890@s.whatsapp.net';

function cursorStore() {
	const map = new Map<string, string>();
	/** Ids the channel asked to be remembered across restarts. */
	const seen = new Set<string>();
	return {
		seen,
		getCursor: (k: string) => map.get(k),
		setCursor(k: string, v: string) {
			map.set(k, v);
		},
		markSeen(id: string) {
			seen.add(id);
		},
		wasSeen: (id: string) => seen.has(id),
	};
}

const OWNER_LID = '111222333444555@lid';

function row(id: string, content: string, timestamp: string, chatJid = OWNER) {
	return {
		id, chat_jid: chatJid, sender: chatJid, content, timestamp, is_from_me: 1,
	};
}

describe('whatsapp channel', () => {
	// The owner's control chat is their "message yourself" chat, so their own
	// instructions arrive with is_from_me=1. Filtering on that flag dropped
	// every real message.
	test('accepts owner messages even though they are from_me', async () => {
		const call: McpCaller = async () => ({
			result: [row('m1', 'hey claude', '2026-08-07T00:10:45+00:00')],
		});

		const channel = createWhatsappChannel({call, cursors: cursorStore(), ownerJids: [OWNER]});
		const events = await channel.poll();

		expect(events).toHaveLength(1);
		expect(events[0]?.text).toBe('hey claude');
	});

	// ...but the agent's own replies come back through the same feed and must
	// not be treated as new instructions, or it talks to itself forever.
	test('ignores messages it sent itself', async () => {
		const messages = [row('sent-1', 'a reply from the agent', '2026-08-07T00:11:00+00:00')];
		const call: McpCaller = async (tool) => (tool === 'whatsapp__send_message'
			? {success: true, message_id: 'sent-1', error: null}
			: {result: messages});

		const channel = createWhatsappChannel({call, cursors: cursorStore(), ownerJids: [OWNER]});
		await channel.send({channel: 'whatsapp', threadId: OWNER, text: 'a reply from the agent'});

		expect(await channel.poll()).toHaveLength(0);
	});

	// WhatsApp delivers a message the moment send_message is called, but the id
	// identifying it as ours only arrives when that call returns — ~1.7s later
	// through the MCP proxy. A poll inside that window used to see a message it
	// could not recognise, and the agent answered its own reply. Seen for real
	// at 1s polling, well after the restart case below was fixed.
	test('does not pick up its own reply while the send is still in flight', async () => {
		const messages: ReturnType<typeof row>[] = [];
		let releaseSend: (() => void) | undefined;

		const call: McpCaller = async (tool) => {
			if (tool === 'whatsapp__send_message') {
				// The message is visible to pollers immediately...
				messages.push(row('sent-1', 'a reply from the agent', '2026-08-07T00:11:00+00:00'));
				// ...but the id only comes back once the bridge answers.
				await new Promise<void>((resolve) => {
					releaseSend = resolve;
				});
				return {success: true, message_id: 'sent-1', error: null};
			}

			return {result: messages};
		};

		const channel = createWhatsappChannel({call, cursors: cursorStore(), ownerJids: [OWNER]});
		const sending = channel.send({channel: 'whatsapp', threadId: OWNER, text: 'a reply from the agent'});

		// A poll fires mid-send, as the 1s loop does.
		const polling = channel.poll();
		releaseSend?.();
		await sending;

		expect(await polling).toHaveLength(0);
	});

	// Waiting only at the start of a poll left a gap: the fetch itself takes
	// ~1.7s, so a send beginning *during* it puts the reply in the rows that
	// poll is about to return, with no id recorded yet. This is the ordering
	// that still echoed after the first fix.
	test('does not pick up a reply sent while the poll was fetching', async () => {
		const messages: ReturnType<typeof row>[] = [];
		let releaseFetch: (() => void) | undefined;
		let releaseSend: (() => void) | undefined;

		const call: McpCaller = async (tool) => {
			if (tool === 'whatsapp__send_message') {
				messages.push(row('sent-1', 'a reply from the agent', '2026-08-07T00:11:00+00:00'));
				await new Promise<void>((resolve) => {
					releaseSend = resolve;
				});
				return {success: true, message_id: 'sent-1', error: null};
			}

			// Hold the fetch open so a send can start underneath it.
			await new Promise<void>((resolve) => {
				releaseFetch = resolve;
			});
			return {result: messages};
		};

		const channel = createWhatsappChannel({call, cursors: cursorStore(), ownerJids: [OWNER]});

		// Poll first, so there is nothing in flight when it starts.
		const polling = channel.poll();
		await Promise.resolve();
		const sending = channel.send({channel: 'whatsapp', threadId: OWNER, text: 'a reply from the agent'});

		// The fetch returns carrying the agent's own just-sent message.
		releaseFetch?.();
		releaseSend?.();
		await sending;

		expect(await polling).toHaveLength(0);
	});

	// The in-memory set of sent ids does not survive a restart, so the last
	// reply sent before one came back in the next poll and was answered as if
	// Adam had written it. Observed for real: after a restart the agent read its
	// own "restarting now" message back and treated it as an instruction.
	test('ignores its own reply even across a restart', async () => {
		const messages = [row('sent-1', 'a reply from the agent', '2026-08-07T00:11:00+00:00')];
		const call: McpCaller = async (tool) => (tool === 'whatsapp__send_message'
			? {success: true, message_id: 'sent-1', error: null}
			: {result: messages});

		// Shared store stands in for state.json surviving the restart.
		const cursors = cursorStore();
		const before = createWhatsappChannel({call, cursors, ownerJids: [OWNER]});
		await before.send({channel: 'whatsapp', threadId: OWNER, text: 'a reply from the agent'});
		expect(cursors.seen.has('sent-1')).toBe(true);

		// A brand new channel, as after a restart: its own set is empty, so the
		// durable record is the only thing standing between it and a self-reply.
		const after = createWhatsappChannel({call, cursors, ownerJids: [OWNER]});
		expect(await after.poll()).toHaveLength(0);
	});

	test('ignores messages from other chats', async () => {
		const call: McpCaller = async () => ({
			result: [row('m2', 'from a group', '2026-08-07T00:10:00+00:00', '123@g.us')],
		});

		const channel = createWhatsappChannel({call, cursors: cursorStore(), ownerJids: [OWNER]});
		expect(await channel.poll()).toHaveLength(0);
	});

	// WhatsApp surfaces the same person under a phone-number JID and a
	// linked-device (@lid) JID depending on the sending device. Accepting only
	// one silently ignored everything sent from the other.
	test('accepts the owner under an alternate linked-device JID', async () => {
		const call: McpCaller = async () => ({
			result: [row('m6', 'Hey Claude, can you see this', '2026-08-07T00:10:45+00:00', OWNER_LID)],
		});

		const channel = createWhatsappChannel({
			call, cursors: cursorStore(), ownerJids: [OWNER, OWNER_LID],
		});
		const events = await channel.poll();

		expect(events).toHaveLength(1);
		expect(events[0]?.threadId).toBe(OWNER_LID);
	});

	// The poll is unfiltered, so the cursor must move past unrelated traffic or
	// the scan window grows without bound while the owner is quiet.
	test('advances the cursor past non-owner messages', async () => {
		const future = new Date(Date.now() + 60_000).toISOString();
		const cursors = cursorStore();
		const call: McpCaller = async () => ({
			result: [row('m7', 'someone else', future, '999@g.us')],
		});

		const channel = createWhatsappChannel({call, cursors, ownerJids: [OWNER]});
		expect(await channel.poll()).toHaveLength(0);
		expect(cursors.getCursor('whatsapp')).toBe(future);
	});

	test('ignores empty messages such as bare reactions', async () => {
		const call: McpCaller = async () => ({
			result: [row('m3', '', '2026-08-07T00:10:00+00:00')],
		});

		const channel = createWhatsappChannel({call, cursors: cursorStore(), ownerJids: [OWNER]});
		expect(await channel.poll()).toHaveLength(0);
	});

	describe('markRead', () => {
		function recorder() {
			const calls: {tool: string; arguments: Record<string, unknown>}[] = [];
			const call: McpCaller = async (tool, arguments_) => {
				calls.push({tool, arguments: arguments_});
				return {success: true};
			};

			return {calls, call};
		}

		test('acknowledges messages against their chat', async () => {
			const {calls, call} = recorder();
			const channel = createWhatsappChannel({call, cursors: cursorStore(), ownerJids: [OWNER]});

			await channel.markRead!([
				{
					id: 'm1', channel: 'whatsapp', threadId: OWNER, text: 'one', timestamp: new Date(),
				},
				{
					id: 'm2', channel: 'whatsapp', threadId: OWNER, text: 'two', timestamp: new Date(),
				},
			]);

			expect(calls).toEqual([{
				tool: 'whatsapp__mark_read',
				arguments: {chat_jid: OWNER, message_ids: ['m1', 'm2']},
			}]);
		});

		// The owner reaches the agent under more than one JID, so a single batch
		// can span chats and cannot be sent as one call.
		test('splits a batch spanning two chats', async () => {
			const {calls, call} = recorder();
			const channel = createWhatsappChannel({
				call, cursors: cursorStore(), ownerJids: [OWNER, OWNER_LID],
			});

			await channel.markRead!([
				{
					id: 'm1', channel: 'whatsapp', threadId: OWNER, text: 'one', timestamp: new Date(),
				},
				{
					id: 'm2', channel: 'whatsapp', threadId: OWNER_LID, text: 'two', timestamp: new Date(),
				},
			]);

			expect(calls.map((c) => c.arguments)).toEqual([
				{chat_jid: OWNER, message_ids: ['m1']},
				{chat_jid: OWNER_LID, message_ids: ['m2']},
			]);
		});

		test('honours the configured tool prefix', async () => {
			const {calls, call} = recorder();
			const channel = createWhatsappChannel({
				call, cursors: cursorStore(), ownerJids: [OWNER], toolPrefix: 'whatsapp-claube',
			});

			await channel.markRead!([{
				id: 'm1', channel: 'whatsapp', threadId: OWNER, text: 'one', timestamp: new Date(),
			}]);

			expect(calls[0]?.tool).toBe('whatsapp-claube__mark_read');
		});
	});

	test('advances the cursor to the newest message seen', async () => {
		// Timestamps must be in the future relative to the default first-run
		// window, or the cursor legitimately does not move.
		const soon = new Date(Date.now() + 60_000).toISOString();
		const later = new Date(Date.now() + 120_000).toISOString();
		const cursors = cursorStore();
		const call: McpCaller = async () => ({
			result: [row('m4', 'first', soon), row('m5', 'second', later)],
		});

		const channel = createWhatsappChannel({call, cursors, ownerJids: [OWNER]});
		await channel.poll();

		expect(cursors.getCursor('whatsapp')).toBe(later);
	});
});
