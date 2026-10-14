import {test, expect} from 'vitest';
import {writeFileSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readTranscript, extractSend} from './transcript.js';

const write = (lines: object[]): string => {
	const path = join(mkdtempSync(join(tmpdir(), 'viewer-test-')), 'session.jsonl');
	writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
	return path;
};

const toolUse = (id: string, name: string, input: object, at = '2026-08-23T06:00:00Z') => ({
	type: 'assistant',
	timestamp: at,
	message: {
		role: 'assistant', content: [{
			type: 'tool_use', id, name, input,
		}],
	},
});

const toolResult = (id: string, content: string, isError = false) => ({
	type: 'user',
	message: {
		role: 'user', content: [{
			type: 'tool_result', tool_use_id: id, content, is_error: isError,
		}],
	},
});

const SEND_COMMAND = 'call-mcp call homelab whatsapp-claube__send_message --args \'{"recipient": "134754749960428@lid", "message": "hello adam"}\'';

test('extractSend pulls the message out of a send command', () => {
	expect(extractSend({command: SEND_COMMAND})).toBe('hello adam');
});

test('extractSend leaves other bash commands alone', () => {
	expect(extractSend({command: 'ls -la'})).toBeUndefined();
	expect(extractSend({command: 'echo send_message'})).toBeUndefined();
	expect(extractSend(undefined)).toBeUndefined();
});

test('extractSend recognises a web reply, sent with curl', () => {
	const command = 'curl -sS localhost:4317/api/send_message --json \'{"message": "hi from the web"}\'';
	expect(extractSend({command})).toBe('hi from the web');
});

test('extractSend follows the shell\'s own apostrophe escapes inside the payload', () => {
	const command = 'call-mcp call homelab whatsapp-claube__send_message --args \'{"recipient": "x", "message": "that\'"\'"\'s it, isn\'\\\'\'t it"}\'';
	expect(extractSend({command})).toBe('that\'s it, isn\'t it');
});

test('a web reply whose JSON was built in a subshell is still a reply row, by the id in its result', async () => {
	const command = 'curl -sS localhost:4317/api/send_message --json "$(python3 -c \'import json; print(json.dumps({"message": "built"}))\')"';
	const path = write([
		toolUse('t1', 'Bash', {command}),
		toolResult('t1', '{"success":true,"message_id":"web-reply-1700000000000-abcd1234"}'),
	]);

	const stored = new Map([['web-reply-1700000000000-abcd1234', 'the text as sent']]);
	const entries = await readTranscript(path, {replyText: (id) => stored.get(id)});
	expect(entries).toEqual([expect.objectContaining({kind: 'reply', text: 'the text as sent', failed: false})]);
	expect(entries[0]).not.toHaveProperty('name');

	// Without the store (older than it, or a restart before it existed) the row
	// is still a reply, just without its words.
	const bare = await readTranscript(path);
	expect(bare[0]).toMatchObject({kind: 'reply', text: '(web reply — text not recorded)'});
});

test('a web message, which has no sender line, shows just its body', async () => {
	const path = write([{
		type: 'user',
		timestamp: '2026-10-14T16:00:00Z',
		message: {role: 'user', content: '[message via web — reply to thread web]\n<<<MESSAGE\nhello from the browser\n MESSAGE'},
	}]);
	expect(await readTranscript(path)).toEqual([
		expect.objectContaining({kind: 'incoming', text: 'hello from the browser'}),
	]);
});

test('a successful send renders as a delivered reply', async () => {
	const path = write([
		toolUse('t1', 'Bash', {command: SEND_COMMAND}),
		toolResult('t1', '{"success":true,"message_id":"ABC"}'),
	]);
	const entries = await readTranscript(path);
	expect(entries).toEqual([
		expect.objectContaining({kind: 'reply', text: 'hello adam', failed: false}),
	]);
});

test('a failed send renders as an undelivered reply', async () => {
	const path = write([
		toolUse('t1', 'Bash', {command: SEND_COMMAND}),
		toolResult('t1', '{"error":"Could not connect"}', true),
	]);
	const entries = await readTranscript(path);
	expect(entries).toEqual([
		expect.objectContaining({kind: 'reply', text: 'hello adam', failed: true}),
	]);
});

test('Edit calls carry a structured diff detail', async () => {
	const path = write([
		toolUse('t1', 'Edit', {
			file_path: '/tmp/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;', replace_all: true,
		}),
	]);
	const entries = await readTranscript(path);
	expect(entries[0]).toMatchObject({
		kind: 'tool',
		name: 'Edit',
		detail: {
			type: 'edit', filePath: '/tmp/a.ts', oldString: 'const a = 1;', newString: 'const a = 2;', replaceAll: true,
		},
	});
});

test('Write calls carry the file content', async () => {
	const path = write([
		toolUse('t1', 'Write', {file_path: '/tmp/b.md', content: 'line1\nline2'}),
	]);
	const entries = await readTranscript(path);
	expect(entries[0]).toMatchObject({
		kind: 'tool',
		detail: {type: 'write', filePath: '/tmp/b.md', content: 'line1\nline2'},
	});
});

test('other tools carry their full input as JSON detail', async () => {
	const path = write([
		toolUse('t1', 'Bash', {command: 'npm test', timeout: 240000, run_in_background: true}),
	]);
	const entries = await readTranscript(path);
	expect(entries[0]).toMatchObject({kind: 'tool', input: 'npm test'});
	const {detail} = (entries[0] as {detail?: {type: string; json?: string}});
	expect(detail?.type).toBe('json');
	expect(detail?.json).toContain('240000');
	expect(detail?.json).toContain('run_in_background');
});

// Screenshots (Read on a png) and downloaded photos come back as image blocks
// in the tool result; files the agent sends go out as base64 fields. Both are
// referenced, not embedded, so the entries feed stays small.
const PNG_B64 = `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==${'A'.repeat(40)}`;

test('image results and inputs are referenced and can be read back', async () => {
	const {readImage, imageMediaType} = await import('./transcript.js');
	const path = write([
		toolUse('t1', 'Read', {file_path: '/tmp/shot.png'}),
		{
			type: 'user',
			message: {
				role: 'user', content: [{
					type: 'tool_result', tool_use_id: 't1', content: [{type: 'image', source: {type: 'base64', media_type: 'image/png', data: PNG_B64}}],
				}],
			},
		},
		toolUse('t2', 'mcp__homelab__whatsapp-claube__send_file', {recipient: 'x', filename: 'a.png', file_content_base64: PNG_B64}),
	]);
	const entries = await readTranscript(path);
	const [read, send] = entries.filter((e) => e.kind === 'tool');
	expect(read?.kind === 'tool' && read.images).toEqual([{id: 't1/out/0', direction: 'out'}]);
	expect(send?.kind === 'tool' && send.images).toEqual([{id: 't2/in/file_content_base64', direction: 'in'}]);
	// The JSON detail does not carry the base64 blob.
	expect(send?.kind === 'tool' && send.detail?.type === 'json' && send.detail.json).toContain('image/png');
	expect(send?.kind === 'tool' && send.detail?.type === 'json' && send.detail.json).not.toContain(PNG_B64);

	const out = await readImage(path, 't1/out/0');
	expect(out?.mediaType).toBe('image/png');
	expect(out?.data.subarray(1, 4).toString()).toBe('PNG');
	const input = await readImage(path, 't2/in/file_content_base64');
	expect(input?.mediaType).toBe('image/png');
	expect(await readImage(path, 't9/out/0')).toBeUndefined();
	expect(imageMediaType('hello world, not an image at all, just some ordinary text content here')).toBeUndefined();
});
