/**
 * Reads a Claude Code session transcript (JSONL) into a shape the viewer
 * prototypes can render.
 *
 * The transcript is the agent's own working record: every message, tool call
 * and result. Claude Code appends to it live, so tailing the file is enough to
 * watch a run in progress — no hooks into the runner needed.
 */
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createInterface} from 'node:readline';

/**
 * Structured detail for tool calls the viewer renders specially. `json` is the
 * fallback: the complete input, pretty-printed, for every other tool.
 */
export type ToolDetail =
	| {type: 'edit'; filePath: string; oldString: string; newString: string; replaceAll?: boolean}
	| {type: 'write'; filePath: string; content: string}
	| {type: 'json'; json: string};

/**
 * An image in a tool call, referenced rather than embedded: the entries feed is
 * re-fetched whenever the transcript changes, and a screenshot is ~100KB of
 * base64. The viewer loads /api/image?id=... on demand instead. `in` images
 * are base64 fields of the tool's input (a file being sent); `out` images are
 * image blocks in its result (a screenshot read back, a downloaded photo).
 */
export type ImageRef = {id: string; direction: 'in' | 'out'};

export type Entry =
	/** `queued` marks a message that arrived while a turn was already running. */
	| {
		kind: 'incoming'; at: string; text: string; queued?: boolean; pending?: boolean;
		/** Channel the message came in on (whatsapp, web, email) and the thread id. */
		via?: string; thread?: string;
		/** Injected by the service (restart notices, scheduled runs, reply checks), not a person. */
		system?: boolean;
	}
	/**
	 * A delivered outgoing message. Modern transcripts: a send_message tool
	 * call, recognised by its command and upgraded to a reply row (failed =
	 * the send errored, i.e. Adam did NOT get it). Older transcripts: the
	 * `>>> reply` marker in assistant prose.
	 */
	| {kind: 'reply'; at: string; text: string; result?: string; failed?: boolean}
	/**
	 * Assistant prose that was NOT delivered — deliberately not called
	 * "thinking": these are ordinary `text` blocks, not the API's `thinking`
	 * blocks (extended thinking, which this transcript contains none of). The
	 * runner delivers only text carrying the reply marker, so everything else
	 * is working-out that Adam never saw.
	 */
	| {kind: 'notes'; at: string; text: string}
	| {
		kind: 'tool'; at: string; name: string; input: string; detail?: ToolDetail; result?: string; failed?: boolean; images?: ImageRef[];
	};

/**
 * The runner delivers a line of exactly this form plus the text following it.
 * Not anchored to the start of the block: prose often precedes the marker in
 * the same block, and that prose is working-out while what follows is really
 * sent. Anchoring hid delivered replies among the undelivered notes.
 */
const REPLY_MARKER = /^>>> reply channel=\S+ thread=\S+[ \t]*\n?/m;

/** Inbound messages arrive wrapped in a routing envelope; show just the body. */
const ENVELOPE = /^\[message via ([^\]\s—]+)(?: — reply to thread (\S+))?\](?:\nfrom: \S+)?\n<<<MESSAGE\n([\s\S]*?)\n\s*MESSAGE\s*$/;

/** Things the service itself injects into the conversation, not people. */
const SYSTEM_PREFIX = /^\s*(\[system notice\]|\[scheduled task|\[SYSTEM NOTIFICATION|Reply check —|The user hasn't heard from you|<task-notification>|<local-command-caveat>|<local-command-stdout>|<command-name>|<system-reminder>)/;

type Inbound = {text: string; via?: string; thread?: string; system?: boolean};

function unwrap(text: string): Inbound {
	const m = ENVELOPE.exec(text);
	if (m) {
		const out: Inbound = {text: (m[3] ?? '').trim(), via: m[1] ?? 'unknown'};
		if (m[2]) {
			out.thread = m[2];
		}

		return out;
	}

	const trimmed = text.trim();
	return SYSTEM_PREFIX.test(trimmed) ? {text: trimmed, system: true} : {text: trimmed};
}

type Raw = {
	type?: string;
	timestamp?: string;
	/** Claude Code's compaction summary: injected as a user message, not from a person. */
	isCompactSummary?: boolean;
	message?: {
		role?: string;
		content?: unknown;
	};
	attachment?: {
		type?: string;
		prompt?: unknown;
	};
};

export type TranscriptOptions = {
	/**
	 * Text of a web reply by the id in the send's result. The curl's command
	 * line may build its JSON in a subshell or with shell escapes the
	 * command-line parser cannot follow; the result's id is unambiguous.
	 */
	replyText?: ((id: string) => string | undefined) | undefined;
};

/** The viewer answers every web reply with this id; the transcript result carries it. */
const WEB_REPLY_ID = /"message_id":"(web-reply-[^"]+)"/;

type ParseState = {
	entries: Entry[];
	// Tool results arrive in a later user message than the call, so calls are
	// indexed by id and back-filled when the result shows up. Sends are indexed
	// too: a send_message call renders as a reply row, and its result decides
	// whether the message actually reached Adam.
	toolsById: Map<string, Entry & {kind: 'tool' | 'reply'}>;
};

function newParseState(): ParseState {
	return {entries: [], toolsById: new Map()};
}

function ingestLine(line: string, state: ParseState, options: TranscriptOptions): void {
	const {entries, toolsById} = state;
	if (!line.trim()) {
		return;
	}

	let raw: Raw;
	try {
		raw = JSON.parse(line) as Raw;
	} catch {
		// Partial final line while the file is being appended to.
		return;
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
				kind: 'incoming', at, queued: true, ...unwrap(text),
			});
		}

		return;
	}

	if (raw.type === 'user') {
		// A plain string is a real inbound message; an array is tool results.
		if (typeof content === 'string') {
			const inbound = unwrap(content);
			if (raw.isCompactSummary) {
				inbound.system = true;
			}

			entries.push({kind: 'incoming', at, ...inbound});
			return;
		}

		for (const block of asBlocks(content)) {
			if (block.type === 'text' && typeof block.text === 'string') {
				entries.push({kind: 'incoming', at, ...unwrap(block.text)});
			}

			const call = block.type === 'tool_result' && typeof block.tool_use_id === 'string'
				? toolsById.get(block.tool_use_id)
				: undefined;
			if (call) {
				applyResult(call, block, options.replyText);
			}
		}

		return;
	}

	if (raw.type !== 'assistant') {
		return;
	}

	for (const block of asBlocks(content)) {
		if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
			entries.push(...splitText(block.text, at));
		}

		if (block.type === 'tool_use' && typeof block.id === 'string') {
			const name = typeof block.name === 'string' ? block.name : 'tool';
			const sent = name === 'Bash' ? extractSend(block.input) : undefined;
			const entry: Entry & {kind: 'tool' | 'reply'} = sent
				? {kind: 'reply', at, text: sent}
				: {
					kind: 'tool',
					at,
					name,
					input: describeInput(block.input),
					...describeDetail(name, block.input),
					...describeInputImages(block.id, block.input),
				};
			toolsById.set(block.id, entry);
			entries.push(entry);
		}
	}
}

export async function readTranscript(path: string, options: TranscriptOptions = {}): Promise<Entry[]> {
	const state = newParseState();
	const rl = createInterface({input: createReadStream(path), crlfDelay: Infinity});

	for await (const line of rl) {
		ingestLine(line, state, options);
	}

	return state.entries;
}

export type TranscriptReader = {
	/**
	 * Entries for the transcript at `path`. The array is the reader's own and
	 * is extended in place on later calls; callers must not mutate it.
	 */
	read(path: string): Promise<Entry[]>;
};

/**
 * Reads a transcript incrementally. Claude Code only ever appends to the
 * file, so after the first pass only the bytes past the last complete line
 * are read and parsed; results that back-fill an earlier call update that
 * entry in place. A path change or a file that shrank (session rotation,
 * rewrite) starts over. Re-parsing a 200MB transcript on every poll took ~2s
 * and made the viewer lag; this takes milliseconds.
 */
export function createTranscriptReader(options: TranscriptOptions = {}): TranscriptReader {
	let path: string | undefined;
	let state = newParseState();
	// Byte offset of the first unconsumed byte: the start of a partial line if
	// the file ends mid-write, else the end of the file.
	let offset = 0;
	let pending: Promise<Entry[]> | undefined;

	const readFrom = async (target: string): Promise<Entry[]> => {
		const {size} = await stat(target);
		if (target !== path || size < offset) {
			path = target;
			state = newParseState();
			offset = 0;
		}

		if (size === offset) {
			return state.entries;
		}

		let remainder = Buffer.alloc(0);
		let total = 0;
		for await (const chunk of createReadStream(target, {start: offset})) {
			const bytes = chunk as Buffer;
			total += bytes.length;
			const buffer = remainder.length > 0 ? Buffer.concat([remainder, bytes]) : bytes;
			let lineStart = 0;
			let newline = buffer.indexOf(0x0A);
			while (newline !== -1) {
				ingestLine(buffer.toString('utf8', lineStart, newline), state, options);
				lineStart = newline + 1;
				newline = buffer.indexOf(0x0A, lineStart);
			}

			// Copied so the chunk it came from can be collected.
			remainder = Buffer.from(buffer.subarray(lineStart));
		}

		// A last line with no newline is usually a write in progress and is left
		// for next time — unless it already parses, in which case it is a complete
		// record (a file written without a trailing newline) and is taken now.
		if (remainder.length > 0) {
			const text = remainder.toString('utf8');
			try {
				JSON.parse(text);
				ingestLine(text, state, options);
				remainder = Buffer.alloc(0);
			} catch {
				// Partial; re-read once its newline has landed.
			}
		}

		offset += total - remainder.length;
		return state.entries;
	};

	return {
		async read(target) {
			// Serialise: two overlapping reads would both append the same lines.
			const run = (pending ?? Promise.resolve([])).then(async () => readFrom(target), async () => readFrom(target));
			pending = run;
			try {
				return await run;
			} finally {
				if (pending === run) {
					pending = undefined;
				}
			}
		},
	};
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

/**
 * The agent sends messages itself, as Bash commands: call-mcp for WhatsApp,
 * curl to the viewer's /api/send_message for the web page. Spotting those
 * turns an opaque Bash row back into a readable reply row — the viewer's
 * conversation view depends on it since the old `>>> reply` parser was removed.
 */
export function extractSend(input: unknown): string | undefined {
	if (input === null || typeof input !== 'object') {
		return undefined;
	}

	const {command} = (input as Record<string, unknown>);
	if (typeof command !== 'string' || !command.includes('send_message')) {
		return undefined;
	}

	// The command may chain other things; only the JSON payload matters. An
	// apostrophe inside a single-quoted shell string is written '"'"' or '\'';
	// allow those, then fold them back before parsing.
	const args = /--(?:args|json)\s+'((?:'"'"'|'\\''|[^'])*)'/.exec(command);
	if (!args?.[1]?.startsWith('{')) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(args[1].replaceAll('\'"\'"\'', '\'').replaceAll('\'\\\'\'', '\'')) as {message?: unknown};
		return typeof parsed.message === 'string' ? parsed.message : undefined;
	} catch {
		// Unparseable payload (e.g. awkward shell quoting): leave it a tool row.
		return undefined;
	}
}

/** Structured detail for tools with a dedicated rendering; full JSON otherwise. */
function describeDetail(name: string, input: unknown): {detail?: ToolDetail} {
	if (input === null || typeof input !== 'object') {
		return {};
	}

	const record = input as Record<string, unknown>;

	if (name === 'Edit'
		&& typeof record.file_path === 'string'
		&& typeof record.old_string === 'string'
		&& typeof record.new_string === 'string') {
		return {
			detail: {
				type: 'edit',
				filePath: record.file_path,
				oldString: record.old_string,
				newString: record.new_string,
				...(record.replace_all === true ? {replaceAll: true} : {}),
			},
		};
	}

	if (name === 'Write' && typeof record.file_path === 'string' && typeof record.content === 'string') {
		return {detail: {type: 'write', filePath: record.file_path, content: record.content}};
	}

	// A base64 image in the input is shown as an image, not 100KB of text.
	const json = JSON.stringify(record, (_key, value: unknown) => (
		typeof value === 'string' && imageMediaType(value) ? `<${imageMediaType(value) ?? 'image'}, ${value.length} chars base64>` : value
	), 2);
	// A one-field input whose value already IS the summary line adds nothing.
	if (json === '{}' || Object.keys(record).length === 0) {
		return {};
	}

	return {detail: {type: 'json', json: json.slice(0, 20_000)}};
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

/**
 * Sniff the format of a base64 string by its first bytes. Only the formats
 * a browser can show; anything else (or ordinary text) is undefined.
 */
export function imageMediaType(base64: string): string | undefined {
	if (base64.length < 64) {
		return undefined;
	}

	if (base64.startsWith('iVBORw0KGgo')) {
		return 'image/png';
	}

	if (base64.startsWith('/9j/')) {
		return 'image/jpeg';
	}

	if (base64.startsWith('R0lGOD')) {
		return 'image/gif';
	}

	if (base64.startsWith('UklGR')) {
		return 'image/webp';
	}

	return undefined;
}

/** Back-fill a tool call (or reply row) with its result when that arrives. */
/**
 * A Bash call whose result carries a web-reply id was the agent replying on
 * the web channel, however its command line was quoted. Rewrite the row as a
 * reply, with the text the viewer recorded when it was sent; if that is gone
 * (older than the store), fall back to whatever the command line yields.
 */
function upgradeWebReply(call: Entry & {kind: 'tool'}, replyText: TranscriptOptions['replyText']): void {
	const id = call.result === undefined ? undefined : WEB_REPLY_ID.exec(call.result)?.[1];
	if (!id) {
		return;
	}

	const text = replyText?.(id) ?? extractSend({command: call.input}) ?? '(web reply — text not recorded)';
	const failed = call.failed === true || !call.result?.includes('"success":true');
	const upgraded = call as Partial<Entry & {kind: 'tool'}>;
	delete upgraded.name;
	delete upgraded.input;
	delete upgraded.detail;
	delete upgraded.images;
	Object.assign(upgraded, {kind: 'reply', text, failed});
}

function applyResult(call: Entry & {kind: 'tool' | 'reply'}, result: Block, replyText?: TranscriptOptions['replyText']): void {
	call.result = flatten(result.content).slice(0, 4000);
	// For a reply row, "failed" means undelivered: the send tool reports
	// {"success":true,...} on stdout only when it went through.
	call.failed = call.kind === 'reply'
		? result.is_error === true || !call.result.includes('"success":true')
		: result.is_error === true;

	if (call.kind === 'tool') {
		const toolUseId = String(result.tool_use_id);
		const out = imageBlockIndexes(result.content).map((index) => ({id: `${toolUseId}/out/${index}`, direction: 'out' as const}));
		if (out.length > 0) {
			call.images = [...(call.images ?? []), ...out];
		}

		upgradeWebReply(call, replyText);
	}
}

function imageBlockIndexes(content: unknown): number[] {
	return asBlocks(content)
		.map((b, index) => (isImageBlock(b) ? index : -1))
		.filter((index) => index >= 0);
}

type ImageBlock = {type: 'image'; source: {type: 'base64'; media_type: string; data: string}};

function isImageBlock(block: unknown): block is ImageBlock {
	if (typeof block !== 'object' || block === null) {
		return false;
	}

	const {type, source} = block as {type?: unknown; source?: {type?: unknown; media_type?: unknown; data?: unknown}};
	return type === 'image' && typeof source === 'object' && source !== null
		&& source.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string';
}

/** Top-level string fields of the input that hold a base64 image. */
function describeInputImages(toolUseId: string, input: unknown): {images?: ImageRef[]} {
	if (input === null || typeof input !== 'object') {
		return {};
	}

	const images = Object.entries(input as Record<string, unknown>)
		.filter(([, value]) => typeof value === 'string' && imageMediaType(value) !== undefined)
		.map(([key]) => ({id: `${toolUseId}/in/${key}`, direction: 'in' as const}));
	return images.length > 0 ? {images} : {};
}

/**
 * Resolve an ImageRef id back to bytes by rescanning the transcript for the
 * tool call it names. A full read per image, but images are fetched only when
 * a row is expanded, and the id is content-stable so the browser caches it.
 */
export async function readImage(path: string, id: string): Promise<{mediaType: string; data: Buffer} | undefined> {
	const match = /^(?<toolUseId>[^/]+)\/(?<direction>in|out)\/(?<where>.+)$/.exec(id);
	if (!match?.groups) {
		return undefined;
	}

	const {toolUseId, direction, where} = match.groups;
	const rl = createInterface({input: createReadStream(path), crlfDelay: Infinity});
	for await (const line of rl) {
		if (!line.includes(toolUseId ?? '')) {
			continue;
		}

		let raw: Raw;
		try {
			raw = JSON.parse(line) as Raw;
		} catch {
			continue;
		}

		for (const block of asBlocks(raw.message?.content)) {
			if (direction === 'out' && block.type === 'tool_result' && block.tool_use_id === toolUseId) {
				const image = asBlocks(block.content)[Number(where)];
				if (isImageBlock(image)) {
					rl.close();
					return {mediaType: image.source.media_type, data: Buffer.from(image.source.data, 'base64')};
				}
			}

			if (direction === 'in' && block.type === 'tool_use' && block.id === toolUseId
				&& block.input !== null && typeof block.input === 'object') {
				const value = (block.input as Record<string, unknown>)[where ?? ''];
				const mediaType = typeof value === 'string' ? imageMediaType(value) : undefined;
				if (typeof value === 'string' && mediaType) {
					rl.close();
					return {mediaType, data: Buffer.from(value, 'base64')};
				}
			}
		}
	}

	return undefined;
}
