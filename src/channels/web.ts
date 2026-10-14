/**
 * Web channel: a message box on the viewer page.
 *
 * Unlike the other channels there is no MCP server to poll. The viewer hands
 * submitted text to {@link WebChannel.receive}, and the next poll drains it.
 * Replies come back the same way in reverse: the agent POSTs to the viewer
 * over loopback, which calls {@link WebChannel.noteSent}. Nothing is stored
 * for display — the viewer already renders both directions from the
 * transcript.
 *
 * Owner check (S1): whoever reaches the viewer is treated as the owner. The
 * viewer sits behind the same ingress auth as everything else on that host,
 * including the agent's desktop, so the chat box widens nothing.
 */
import {randomUUID} from 'node:crypto';
import type {AgentEvent, Channel} from '../types.js';

export const WEB_CHANNEL_ID = 'web';

/** There is one conversation on the page, so one thread. */
export const WEB_THREAD_ID = 'web';

export type WebChannel = Channel & {
	/** Queue a message typed into the page. Returns the event id. */
	receive: (text: string) => string;
	/** Record that the agent has replied, for the runner's reply-check. */
	noteSent: () => void;
};

export type WebOptions = {
	onSent?: (() => void) | undefined;
};

export function createWebChannel(options: WebOptions = {}): WebChannel {
	// In memory only: a message is queued for at most one poll interval, and the
	// POST that queued it fails outright if the process is down.
	let pending: AgentEvent[] = [];

	return {
		id: WEB_CHANNEL_ID,

		async poll() {
			const events = pending;
			pending = [];
			return events;
		},

		receive(text) {
			const id = `web-${randomUUID()}`;
			pending.push({
				id,
				channel: WEB_CHANNEL_ID,
				threadId: WEB_THREAD_ID,
				text,
				timestamp: new Date(),
			});
			return id;
		},

		noteSent() {
			options.onSent?.();
		},

		// The page shows replies by reading the transcript, so a send made by the
		// harness rather than the agent would never be seen. Fail loudly instead.
		async send() {
			throw new Error('the web channel has no harness-side send: the agent replies via the viewer\'s /api/send_message');
		},
	};
}
