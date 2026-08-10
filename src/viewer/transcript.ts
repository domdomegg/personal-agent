/**
 * Reads a Claude Code session transcript (JSONL) into a shape the viewer
 * prototypes can render.
 *
 * The transcript is the agent's own working record: every message, tool call
 * and result. Claude Code appends to it live, so tailing the file is enough to
 * watch a run in progress — no hooks into the runner needed.
 */
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';

export type Entry =
	/** `queued` marks a message that arrived while a turn was already running. */
	| {kind: 'incoming'; at: string; text: string; queued?: boolean}
	| {kind: 'reply'; at: string; text: string}
	/**
	 * Assistant prose that was NOT delivered — deliberately not called
	 * "thinking": these are ordinary `text` blocks, not the API's `thinking`
	 * blocks (extended thinking, which this transcript contains none of). The
	 * runner delivers only text carrying the reply marker, so everything else
	 * is working-out that Adam never saw.
	 */
	| {kind: 'notes'; at: string; text: string}
	| {kind: 'tool'; at: string; name: string; input: string; result?: string; failed?: boolean};

/**
 * The runner delivers a line of exactly this form plus the text following it.
 * Not anchored to the start of the block: prose often precedes the marker in
 * the same block, and that prose is working-out while what follows is really
 * sent. Anchoring hid delivered replies among the undelivered notes.
 */
const REPLY_MARKER = /^>>> reply channel=\S+ thread=\S+[ \t]*\n?/m;

/** Inbound messages arrive wrapped in a routing envelope; show just the body. */
const ENVELOPE = /^\[message via [^\]]+]\nfrom: \S+\n<<<MESSAGE\n([\s\S]*?)\n\s*MESSAGE\s*$/;

function unwrap(text: string): string {
	return ENVELOPE.exec(text)?.[1]?.trim() ?? text.trim();
}

type Raw = {
	type?: string;
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
	attachment?: {
		type?: string;
		prompt?: unknown;
	};
};

export async function readTranscript(path: string): Promise<Entry[]> {
	const entries: Entry[] = [];
	// Tool results arrive in a later user message than the call, so calls are
	// indexed by id and back-filled when the result shows up.
	const toolsById = new Map<string, Entry & {kind: 'tool'}>();

	const rl = createInterface({input: createReadStream(path), crlfDelay: Infinity});

	for await (const line of rl) {
		if (!line.trim()) {
			continue;
		}

		let raw: Raw;
		try {
			raw = JSON.parse(line) as Raw;
		} catch {
			// Partial final line while the file is being appended to.
			continue;
		}

		const at = raw.timestamp ?? '';
		const content = raw.message?.content;

		// A message sent while a turn is already running is recorded as a
		// queued_command attachment, not a user message — so reading only `user`
		// records silently dropped every mid-run message Adam sent.
		if (raw.type === 'attachment' && raw.attachment?.type === 'queued_command') {
			const text = flatten(raw.attachment.prompt).trim();
			if (text) {
				entries.push({
					kind: 'incoming', at, queued: true, text: unwrap(text),
				});
			}

			continue;
		}

		if (raw.type === 'user') {
			// A plain string is a real inbound message; an array is tool results.
			if (typeof content === 'string') {
				entries.push({kind: 'incoming', at, text: unwrap(content)});
				continue;
			}

			for (const block of asBlocks(content)) {
				if (block.type === 'text' && typeof block.text === 'string') {
					entries.push({kind: 'incoming', at, text: unwrap(block.text)});
				}

				const call = block.type === 'tool_result' && typeof block.tool_use_id === 'string'
					? toolsById.get(block.tool_use_id)
					: undefined;
				if (call) {
					call.result = flatten(block.content).slice(0, 4000);
					call.failed = block.is_error === true;
				}
			}

			continue;
		}

		if (raw.type !== 'assistant') {
			continue;
		}

		for (const block of asBlocks(content)) {
			if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
				entries.push(...splitText(block.text, at));
			}

			if (block.type === 'tool_use' && typeof block.id === 'string') {
				const entry: Entry & {kind: 'tool'} = {
					kind: 'tool',
					at,
					name: typeof block.name === 'string' ? block.name : 'tool',
					input: describeInput(block.input),
				};
				toolsById.set(block.id, entry);
				entries.push(entry);
			}
		}
	}

	return entries;
}

/**
 * One assistant text block can hold working-out and then the delivered reply,
 * so it may yield two entries.
 */
function splitText(text: string, at: string): Entry[] {
	const marker = REPLY_MARKER.exec(text);
	if (marker?.index === undefined) {
		return [{kind: 'notes', at, text: text.trim()}];
	}

	const out: Entry[] = [];
	const before = text.slice(0, marker.index).trim();
	const sent = text.slice(marker.index + marker[0].length).trim();

	if (before) {
		out.push({kind: 'notes', at, text: before});
	}

	if (sent) {
		out.push({kind: 'reply', at, text: sent});
	}

	return out;
}

type Block = {
	type?: string;
	text?: unknown;
	id?: unknown;
	name?: unknown;
	input?: unknown;
	tool_use_id?: unknown;
	content?: unknown;
	is_error?: unknown;
};

function asBlocks(content: unknown): Block[] {
	return Array.isArray(content) ? (content as Block[]) : [];
}

/** The one field worth showing for the common tools; JSON for the rest. */
function describeInput(input: unknown): string {
	if (input === null || typeof input !== 'object') {
		return '';
	}

	const record = input as Record<string, unknown>;
	for (const key of ['command', 'file_path', 'pattern', 'prompt', 'url']) {
		if (typeof record[key] === 'string') {
			return record[key];
		}
	}

	return JSON.stringify(record).slice(0, 300);
}

function flatten(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}

	if (!Array.isArray(content)) {
		return '';
	}

	return content
		.map((block: unknown) => {
			const b = block as Block;
			return b?.type === 'text' && typeof b.text === 'string' ? b.text : `[${String(b?.type ?? 'block')}]`;
		})
		.join('\n');
}
