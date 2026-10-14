/**
 * Web channel: a message box on the viewer page.
 *
 * Unlike the other channels there is no MCP server to poll. The viewer hands
 * submitted text to {@link WebChannel.receive}, and the next poll drains it.
 * Replies come back the same way in reverse: the agent POSTs to the viewer
 * over loopback, which calls {@link WebChannel.noteSent}. The reply's text is
 * kept (in memory, and in a JSONL file when `storePath` is set) keyed by the
 * id the viewer answers with: the transcript shows the curl as a Bash call
 * whose quoting is whatever the agent typed, so the viewer recovers the text
 * from here by the id in the call's result rather than by parsing the shell.
 *
 * Owner check (S1): whoever reaches the viewer is treated as the owner. The
 * viewer sits behind the same ingress auth as everything else on that host,
 * including the agent's desktop, so the chat box widens nothing.
 */
import {randomUUID} from 'node:crypto';
import {appendFileSync, existsSync, readFileSync} from 'node:fs';
import type {AgentEvent, Channel} from '../types.js';

export const WEB_CHANNEL_ID = 'web';

/** There is one conversation on the page, so one thread. */
export const WEB_THREAD_ID = 'web';

export type WebChannel = Channel & {
	/** Queue a message typed into the page. Returns the event id. */
	receive: (text: string) => string;
	/** Record a reply (text as sent), for the runner's reply-check and for display. Returns its id. */
	noteSent: (message: string) => string;
	/** The text of an earlier reply, by the id `noteSent` returned; undefined if unknown. */
	replyText: (id: string) => string | undefined;
	/** Messages received recently, oldest first, for showing them before the transcript has them. */
	recent: () => {id: string; text: string; at: string}[];
};

/** How many received messages are remembered for the pending view. */
const RECENT_LIMIT = 50;

export type WebOptions = {
	onSent?: (() => void) | undefined;
	/** Where reply texts persist across restarts (JSONL, appended). Memory only if unset. */
	storePath?: string | undefined;
};

/** Replies kept in memory; the file keeps everything. */
const MEMORY_LIMIT = 1000;

function loadReplies(path: string | undefined): Map<string, string> {
	const replies = new Map<string, string>();
	if (!path || !existsSync(path)) {
		return replies;
	}

	for (const line of readFileSync(path, 'utf8').split('\n')) {
		if (!line.trim()) {
			continue;
		}

		try {
			const {id, message} = JSON.parse(line) as {id?: unknown; message?: unknown};
			if (typeof id === 'string' && typeof message === 'string') {
				replies.set(id, message);
			}
		} catch {
			// A torn final line from an interrupted append; nothing to recover.
		}
	}

	return replies;
}

export function createWebChannel(options: WebOptions = {}): WebChannel {
	// In memory only: a message is queued for at most one poll interval, and the
	// POST that queued it fails outright if the process is down.
	let pending: AgentEvent[] = [];
	const replies = loadReplies(options.storePath);
	const received: {id: string; text: string; at: string}[] = [];

	return {
		id: WEB_CHANNEL_ID,

		async poll() {
			const events = pending;
			pending = [];
			return events;
		},

		receive(text) {
			const id = `web-${randomUUID()}`;
			const timestamp = new Date();
			pending.push({
				id,
				channel: WEB_CHANNEL_ID,
				threadId: WEB_THREAD_ID,
				text,
				timestamp,
			});
			received.push({id, text, at: timestamp.toISOString()});
			if (received.length > RECENT_LIMIT) {
				received.shift();
			}

			return id;
		},

		noteSent(message) {
			const id = `web-reply-${Date.now()}-${randomUUID().slice(0, 8)}`;
			replies.set(id, message);
			while (replies.size > MEMORY_LIMIT) {
				const oldest = replies.keys().next().value;
				if (oldest === undefined) {
					break;
				}

				replies.delete(oldest);
			}

			if (options.storePath) {
				appendFileSync(options.storePath, `${JSON.stringify({id, message, at: new Date().toISOString()})}\n`);
			}

			options.onSent?.();
			return id;
		},

		replyText(id) {
			return replies.get(id);
		},

		recent() {
			return [...received];
		},

		// The page shows replies by reading the transcript, so a send made by the
		// harness rather than the agent would never be seen. Fail loudly instead.
		async send() {
			throw new Error('the web channel has no harness-side send: the agent replies via the viewer\'s /api/send_message');
		},
	};
}
