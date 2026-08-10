/**
 * Email channel, over the Gmail MCP server.
 *
 * Uses a Gmail label as the cursor: handled mail is labelled, and the poll
 * query excludes anything labelled. That keeps the "have I dealt with this?"
 * state on the server, so it survives losing local state entirely (F6).
 */
import type {AgentEvent, Channel} from '../types.js';
import type {McpCaller} from '../mcp.js';

export type EmailOptions = {
	call: McpCaller;
	/** Only mail from this address becomes an event (S1). */
	ownerAddress: string;
	/** Label applied once an email has been turned into an event. */
	handledLabel?: string | undefined;
	/** Extra Gmail search terms, ANDed with the owner filter. */
	query?: string | undefined;
};

export const EMAIL_CHANNEL_ID = 'email';

const DEFAULT_HANDLED_LABEL = 'agent-handled';

export function createEmailChannel(options: EmailOptions): Channel {
	const {call, ownerAddress} = options;
	const handledLabel = options.handledLabel ?? DEFAULT_HANDLED_LABEL;
	let labelId: string | undefined;

	/** Find or create the bookkeeping label. */
	async function ensureLabel(): Promise<string> {
		if (labelId) {
			return labelId;
		}

		const listed = await call('gmail__labels_list', {});
		const existing = findLabel(listed, handledLabel);
		if (existing) {
			labelId = existing;
			return existing;
		}

		const created = await call('gmail__label_create', {name: handledLabel});
		const id = readString(created, 'id');
		if (!id) {
			throw new Error(`Could not create Gmail label ${handledLabel}`);
		}

		labelId = id;
		return id;
	}

	return {
		id: EMAIL_CHANNEL_ID,

		async poll() {
			const label = await ensureLabel();

			const terms = [
				`from:${ownerAddress}`,
				`-label:${handledLabel}`,
				options.query ?? 'newer_than:2d',
			];

			const listed = await call('gmail__messages_list', {
				q: terms.join(' '),
				maxResults: 25,
			});

			const ids = extractMessageIds(listed);
			const events: AgentEvent[] = [];

			for (const id of ids) {
				// eslint-disable-next-line no-await-in-loop
				const full = await call('gmail__message_get', {messageId: id, format: 'full'});
				const parsed = parseMessage(full, id);

				// Label before yielding: if we crash now the email is skipped
				// rather than replayed, matching the at-most-once rule.
				// eslint-disable-next-line no-await-in-loop
				await call('gmail__message_modify', {messageId: id, addLabelIds: [label]});

				if (parsed) {
					events.push(parsed);
				}
			}

			return events;
		},

		async send(message) {
			await call('gmail__message_send', {
				to: [ownerAddress],
				subject: 'Re: (agent)',
				body: message.text,
				threadId: message.threadId,
			});
		},
	};
}

function parseMessage(response: unknown, id: string): AgentEvent | undefined {
	if (typeof response !== 'object' || response === null) {
		return undefined;
	}

	const record = response as Record<string, unknown>;
	const threadId = readString(record, 'threadId') ?? id;
	const text = readString(record, 'body')
		?? readString(record, 'snippet')
		?? '';

	if (text.trim() === '') {
		return undefined;
	}

	const subject = readString(record, 'subject');
	const dateRaw = readString(record, 'date') ?? readString(record, 'internalDate');
	const timestamp = dateRaw ? new Date(dateRaw) : new Date();

	return {
		id,
		channel: EMAIL_CHANNEL_ID,
		threadId,
		text: subject ? `subject: ${subject}\n\n${text}` : text,
		timestamp: Number.isNaN(timestamp.getTime()) ? new Date() : timestamp,
		sender: readString(record, 'from'),
	};
}

function extractMessageIds(response: unknown): string[] {
	if (typeof response !== 'object' || response === null) {
		return [];
	}

	const {messages} = (response as Record<string, unknown>);
	if (!Array.isArray(messages)) {
		return [];
	}

	return messages
		.map((m) => (typeof m === 'object' && m !== null ? readString(m as Record<string, unknown>, 'id') : undefined))
		.filter((id): id is string => id !== undefined);
}

function findLabel(response: unknown, name: string): string | undefined {
	if (typeof response !== 'object' || response === null) {
		return undefined;
	}

	const {labels} = (response as Record<string, unknown>);
	if (!Array.isArray(labels)) {
		return undefined;
	}

	for (const label of labels) {
		if (typeof label === 'object' && label !== null) {
			const record = label as Record<string, unknown>;
			if (record.name === name) {
				return readString(record, 'id');
			}
		}
	}

	return undefined;
}

function readString(record: Record<string, unknown> | unknown, key: string): string | undefined {
	if (typeof record !== 'object' || record === null) {
		return undefined;
	}

	const value = (record as Record<string, unknown>)[key];
	return typeof value === 'string' ? value : undefined;
}
