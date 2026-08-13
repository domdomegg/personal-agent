/**
 * WhatsApp channel, over the whatsapp-mcp-extended server.
 */
import type {AgentEvent, Channel, WatchEntry} from '../types.js';
import type {McpCaller} from '../mcp.js';

export type WhatsappOptions = {
	call: McpCaller;
	/** Persists the poll position across restarts. */
	cursors: {
		getCursor: (channel: string) => string | undefined;
		setCursor: (channel: string, cursor: string) => void;
		/**
		 * Records a message id as already handled, durably. Used for the agent's
		 * own sends: an in-memory set alone is lost on restart, and the reply is
		 * then read back as a fresh instruction.
		 */
		markSeen: (id: string) => void;
		/** Whether an id was already handled, including before a restart. */
		wasSeen: (id: string) => boolean;
	};
	/**
	 * Only messages in these chats become events (S1). WhatsApp surfaces the
	 * same person under both a phone-number JID (`…@s.whatsapp.net`) and a
	 * linked-device JID (`…@lid`), and which one a message arrives under
	 * depends on the device it was sent from — so list both. Replies go to the
	 * chat the message arrived in.
	 */
	ownerJids: string[];
	/**
	 * Which MCP server backs this channel, e.g. `whatsapp`. Set this when the
	 * agent has its own WhatsApp account rather than sharing the owner's: a
	 * second registration of the same server, bound to a different
	 * mcp-auth-wrapper profile, exposes identical tools under a different prefix.
	 */
	toolPrefix?: string | undefined;
	/**
	 * Chats to listen to without taking instructions from. Their messages become
	 * events carrying the watch's note; they are still data, not commands (S1).
	 */
	watches?: WatchEntry[] | undefined;
};

type RawMessage = {
	id?: unknown;
	chat_jid?: unknown;
	sender?: unknown;
	content?: unknown;
	timestamp?: unknown;
	is_from_me?: unknown;
};

export const WHATSAPP_CHANNEL_ID = 'whatsapp';

export function createWhatsappChannel(options: WhatsappOptions): Channel {
	const {call, cursors} = options;
	const tool = options.toolPrefix ?? 'whatsapp';

	const ownerJids = new Set(options.ownerJids);
	const watches = new Map((options.watches ?? []).map((watch) => [watch.chatJid, watch]));

	// Ids of messages this agent sent, so its own replies are not mistaken for
	// new instructions. Bounded: only recent sends can still be in a poll window.
	const sentMessageIds = new Set<string>();

	// Sends currently awaiting an id from the bridge. WhatsApp delivers the
	// message as soon as send_message is called, but the id that identifies it
	// as ours only comes back when that call returns — roughly 1.7s later,
	// through the MCP proxy. A poll landing in that window sees a message it has
	// no way to recognise, which is how the agent ended up answering its own
	// reply. Polls wait for it to close.
	let sendsInFlight = 0;
	let settleIdle: (() => void) | undefined;
	let idle: Promise<void> | undefined;

	function beginSend(): void {
		sendsInFlight += 1;
		idle ??= new Promise<void>((resolve) => {
			settleIdle = resolve;
		});
	}

	function endSend(): void {
		sendsInFlight -= 1;
		if (sendsInFlight === 0) {
			settleIdle?.();
			idle = undefined;
			settleIdle = undefined;
		}
	}

	return {
		id: WHATSAPP_CHANNEL_ID,

		async poll() {
			// Let any in-flight send record its id first, so this poll can tell
			// the agent's own reply from a new message.
			if (idle) {
				await idle;
			}

			// Resume from the last message we saw; on first run take a short
			// window so we don't replay the entire history.
			const after = cursors.getCursor(WHATSAPP_CHANNEL_ID)
				?? new Date(Date.now() - (5 * 60_000)).toISOString();

			// Deliberately not filtered by chat_jid server-side: the owner may
			// appear under more than one JID, and the server filter matches only
			// one exactly. Filter locally instead.
			const response = await call(`${tool}__list_messages`, {
				after,
				limit: 100,
			});

			// Wait again, this time for sends that began *during* the fetch. The
			// fetch itself takes ~1.7s, so a reply sent while it was in progress
			// is already in these rows but its id was not recorded when the poll
			// started. Checking only on entry left exactly that gap open.
			if (idle) {
				await idle;
			}

			const rows = extractRows(response);
			const events: AgentEvent[] = [];
			let newest = after;

			for (const row of rows) {
				const id = typeof row.id === 'string' ? row.id : undefined;
				const chatJid = typeof row.chat_jid === 'string' ? row.chat_jid : undefined;
				const text = typeof row.content === 'string' ? row.content : '';
				const timestamp = typeof row.timestamp === 'string' ? row.timestamp : undefined;

				if (!id || !chatJid || !timestamp) {
					continue;
				}

				// Advance over every message seen, not just the owner's: the poll
				// covers all chats, so anchoring the cursor to owner traffic alone
				// would leave it stale and rescan an ever-growing window whenever
				// the owner is quiet.
				if (timestamp > newest) {
					newest = timestamp;
				}

				// The agent's own replies come back in the feed and must not be
				// answered. `is_from_me` cannot be used for this: the owner's
				// control chat is their "message yourself" chat, where every
				// message — theirs and the agent's alike — is from them. So track
				// what we actually sent instead.
				//
				// Checked against durable state as well as this process's own
				// set, so a reply sent just before a restart is still recognised
				// by the process that comes up after it.
				if (sentMessageIds.has(id) || cursors.wasSeen(id)) {
					continue;
				}

				// Only the owner's own chats, and explicitly watched ones, reach
				// the agent (S1). Watched chats are heard, not obeyed: the note
				// travels with the event, and the body stays fenced as data.
				const isOwner = ownerJids.has(chatJid);
				const watch = isOwner ? undefined : watches.get(chatJid);
				if (!isOwner && !watch) {
					continue;
				}

				// In a watched chat `is_from_me` is reliable — unlike the owner's
				// message-yourself control chat — and marks the agent's own
				// reactions and replies coming back around.
				if (watch && Boolean(row.is_from_me)) {
					continue;
				}

				if (text.trim() === '') {
					continue;
				}

				events.push({
					id,
					channel: WHATSAPP_CHANNEL_ID,
					threadId: chatJid,
					text,
					timestamp: new Date(timestamp),
					sender: typeof row.sender === 'string' ? row.sender : undefined,
					note: watch?.note,
				});
			}

			if (newest !== after) {
				cursors.setCursor(WHATSAPP_CHANNEL_ID, newest);
			}

			return events;
		},

		async markRead(events) {
			// Only owner chats: the receipt is a signal to the owner that the
			// agent has their message. Watched chats get no ticks — the bridge
			// would also need per-sender receipts for groups, which this
			// deliberately does not get into.
			const acknowledgeable = events.filter((event) => ownerJids.has(event.threadId));

			// Grouped by chat, since the bridge marks a batch within a single
			// chat per call — and the owner may write from more than one JID.
			const byChat = new Map<string, string[]>();
			for (const event of acknowledgeable) {
				const ids = byChat.get(event.threadId) ?? [];
				ids.push(event.id);
				byChat.set(event.threadId, ids);
			}

			// `sender_jid` is only required for group chats, and the owner's
			// control chats are direct ones.
			await Promise.all([...byChat].map(async ([chatJid, messageIds]) => call(`${tool}__mark_read`, {
				chat_jid: chatJid,
				message_ids: messageIds,
			})));
		},

		async send(message) {
			beginSend();
			try {
				const response = await call(`${tool}__send_message`, {
					recipient: message.threadId,
					message: message.text,
				});

				const id = readMessageId(response);
				if (id) {
					sentMessageIds.add(id);
					// Also recorded durably: a restart clears the in-memory set,
					// and the last reply sent before it would otherwise come back
					// in the next poll and be answered as if Adam had written it.
					cursors.markSeen(id);
					if (sentMessageIds.size > 200) {
						// Drop the oldest; a send far enough back cannot still
						// appear in a poll window.
						sentMessageIds.delete(sentMessageIds.values().next().value!);
					}
				}
			} finally {
				// Released only after the id is recorded, so a waiting poll sees it.
				endSend();
			}
		},
	};
}

/** The id WhatsApp assigns to a message we just sent. */
function readMessageId(response: unknown): string | undefined {
	if (typeof response !== 'object' || response === null) {
		return undefined;
	}

	const value = (response as Record<string, unknown>).message_id;
	return typeof value === 'string' ? value : undefined;
}

function extractRows(response: unknown): RawMessage[] {
	if (Array.isArray(response)) {
		return response as RawMessage[];
	}

	if (typeof response === 'object' && response !== null) {
		const {result} = (response as Record<string, unknown>);
		if (Array.isArray(result)) {
			return result as RawMessage[];
		}
	}

	return [];
}
