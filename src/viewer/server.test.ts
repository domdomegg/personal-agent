import {
	describe, test, expect, afterEach,
} from 'vitest';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer, type Server} from 'node:http';
import {connect} from 'node:net';
import {networkInterfaces} from 'node:os';
import {startViewer} from './server.js';
import {createWebChannel} from '../channels/web.js';

// A fresh session has no transcript, and often no projects/ directory either:
// Claude Code writes both on the first turn. The viewer used to watch the file
// directly, so it threw ENOENT and stayed dead for exactly the session you most
// want to watch.
const viewers: {close: () => void}[] = [];
const directories: string[] = [];

function start(transcriptPath: string, desktopPort?: number, web?: Parameters<typeof startViewer>[0]['web']): ReturnType<typeof startViewer> {
	// Port 0 lets the OS pick a free one, so tests never clash.
	const viewer = startViewer({
		transcriptPath, port: 0, desktopPort, web,
	});
	viewers.push(viewer);
	return viewer;
}

function scratch(): string {
	const directory = mkdtempSync(join(tmpdir(), 'viewer-test-'));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	while (viewers.length > 0) {
		viewers.pop()?.close();
	}

	while (directories.length > 0) {
		const directory = directories.pop();
		if (directory) {
			rmSync(directory, {recursive: true, force: true});
		}
	}
});

describe('startViewer', () => {
	test('starts when the transcript does not exist yet', () => {
		const path = join(scratch(), 'session.jsonl');

		expect(() => start(path)).not.toThrow();
	});

	test('starts when the containing directory does not exist yet', () => {
		const path = join(scratch(), 'projects', '-home-agent', 'session.jsonl');

		expect(() => start(path)).not.toThrow();
	});

	test('starts when the transcript already exists', () => {
		const path = join(scratch(), 'session.jsonl');
		writeFileSync(path, '');

		expect(() => start(path)).not.toThrow();
	});

	test('closing is safe before the transcript appears', () => {
		const path = join(scratch(), 'session.jsonl');
		const viewer = start(path);

		expect(() => {
			viewer.close();
		}).not.toThrow();
	});
});

// /desktop/ is the agent's noVNC desktop, proxied so it shares the viewer's
// hostname and auth. Stand in for websockify with a stub that serves a page
// and echoes bytes over an upgraded connection.
describe('desktop proxy', () => {
	const stubs: Server[] = [];

	afterEach(() => {
		while (stubs.length > 0) {
			stubs.pop()?.close();
		}
	});

	async function stubDesktop(): Promise<number> {
		const stub = createServer((request, response) => {
			response.writeHead(200, {'content-type': 'text/plain'});
			response.end(`stub novnc ${request.url}`);
		});
		stub.on('upgrade', (request, socket) => {
			socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Path: ${request.url}\r\n\r\n`);
			socket.on('data', (chunk) => socket.write(chunk));
		});
		stubs.push(stub);
		await new Promise<void>((resolve) => {
			stub.listen(0, '127.0.0.1', resolve);
		});
		const address = stub.address();
		return typeof address === 'object' && address !== null ? address.port : 0;
	}

	test('passes plain requests through with the prefix stripped', async () => {
		const desktopPort = await stubDesktop();
		const port = await start(join(scratch(), 'session.jsonl'), desktopPort).ready;

		const response = await fetch(`http://127.0.0.1:${port}/desktop/vnc.html?x=1`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('stub novnc /vnc.html?x=1');
	});

	test('/desktop redirects into noVNC with the websocket path set', async () => {
		const port = await start(join(scratch(), 'session.jsonl'), 1).ready;

		const response = await fetch(`http://127.0.0.1:${port}/desktop`, {redirect: 'manual'});
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('/desktop/vnc.html?autoconnect=1&resize=scale&path=desktop/websockify');
	});

	test('splices an upgraded connection through to websockify', async () => {
		const desktopPort = await stubDesktop();
		const port = await start(join(scratch(), 'session.jsonl'), desktopPort).ready;

		const received = await new Promise<string>((resolve, reject) => {
			const socket = connect(port, '127.0.0.1', () => {
				socket.write('GET /desktop/websockify HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
			});
			let buffer = '';
			socket.on('data', (chunk) => {
				buffer += chunk.toString();
				if (buffer.includes('\r\n\r\n') && !buffer.includes('ping')) {
					socket.write('ping');
				}

				if (buffer.endsWith('ping')) {
					socket.end();
					resolve(buffer);
				}
			});
			socket.on('error', reject);
		});

		expect(received).toContain('HTTP/1.1 101');
		expect(received).toContain('X-Path: /websockify');
		expect(received.endsWith('ping')).toBe(true);
	});

	test('says so when the desktop is not running', async () => {
		// Nothing listens on port 1.
		const port = await start(join(scratch(), 'session.jsonl'), 1).ready;

		const response = await fetch(`http://127.0.0.1:${port}/desktop/vnc.html`);
		expect(response.status).toBe(502);
		expect(await response.text()).toContain('desktop is not running');
	});
});

describe('web chat', () => {
	const post = async (port: number, path: string, body: unknown, host = '127.0.0.1', contentType = 'application/json'): Promise<Response> => fetch(`http://${host}:${port}${path}`, {
		method: 'POST',
		headers: {'content-type': contentType},
		body: JSON.stringify(body),
	});

	test('a message posted from the page reaches the channel', async () => {
		const web = createWebChannel();
		const port = await start(join(scratch(), 'session.jsonl'), undefined, web).ready;

		const response = await post(port, '/api/message', {text: 'hi there'});
		expect(response.status).toBe(200);
		const {id} = await response.json() as {id: string};

		expect(await web.poll()).toEqual([expect.objectContaining({id, text: 'hi there'})]);
	});

	test('refuses non-JSON posts, which is what keeps cross-site forms out', async () => {
		const web = createWebChannel();
		const port = await start(join(scratch(), 'session.jsonl'), undefined, web).ready;

		const response = await post(port, '/api/message', {text: 'hi'}, '127.0.0.1', 'text/plain');
		expect(response.status).toBe(400);
		expect(await web.poll()).toEqual([]);
	});

	test('refuses an empty message', async () => {
		const web = createWebChannel();
		const port = await start(join(scratch(), 'session.jsonl'), undefined, web).ready;

		expect((await post(port, '/api/message', {text: '  '})).status).toBe(400);
	});

	test('a message typed into the page shows as a pending row until the transcript has it', async () => {
		const web = createWebChannel();
		const transcriptPath = join(scratch(), 'session.jsonl');
		const port = await start(transcriptPath, undefined, web).ready;

		await post(port, '/api/message', {text: 'are you there'});
		const before = await (await fetch(`http://127.0.0.1:${port}/api/entries`)).json() as {entries: {kind: string; text?: string; pending?: boolean}[]};
		expect(before.entries).toEqual([expect.objectContaining({kind: 'incoming', text: 'are you there', pending: true})]);

		// Claude Code records the message: the real row replaces the pending one.
		writeFileSync(transcriptPath, `${JSON.stringify({type: 'user', timestamp: '2026-10-14T16:00:00Z', message: {role: 'user', content: '[message via web — reply to thread web]\n<<<MESSAGE\nare you there\n MESSAGE'}})}\n`);
		const after = await (await fetch(`http://127.0.0.1:${port}/api/entries`)).json() as {entries: {kind: string; text?: string; pending?: boolean}[]};
		expect(after.entries).toHaveLength(1);
		expect(after.entries[0]).toMatchObject({kind: 'incoming', text: 'are you there'});
		expect(after.entries[0]?.pending).toBeUndefined();
	});

	test('the agent\'s reply over loopback is acknowledged the way the transcript expects', async () => {
		let sent = 0;
		const web = createWebChannel({
			onSent() {
				sent += 1;
			},
		});
		const port = await start(join(scratch(), 'session.jsonl'), undefined, web).ready;

		const response = await post(port, '/api/send_message', {message: 'hello adam'});
		expect(response.status).toBe(200);
		const body = await response.json() as {success: boolean; message_id: string};
		expect(body.success).toBe(true);
		expect(web.replyText(body.message_id)).toBe('hello adam');
		expect(sent).toBe(1);
	});

	test('a reply arriving from off the box is refused: viewers cannot speak as the agent', async () => {
		const external = Object.values(networkInterfaces()).flat()
			.find((i) => i?.family === 'IPv4' && !i.internal)?.address;
		if (!external) {
			return;
		}

		let sent = 0;
		const web = createWebChannel({
			onSent() {
				sent += 1;
			},
		});
		const port = await start(join(scratch(), 'session.jsonl'), undefined, web).ready;

		const response = await post(port, '/api/send_message', {message: 'forged'}, external);
		expect(response.status).toBe(403);
		expect(sent).toBe(0);
	});

	test('without a web channel the page has no message box and the endpoints do not exist', async () => {
		const port = await start(join(scratch(), 'session.jsonl')).ready;

		expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).not.toContain('id="composer"');
		expect((await post(port, '/api/message', {text: 'hi'})).status).toBe(404);
	});

	test('with one, the page has the message box', async () => {
		const port = await start(join(scratch(), 'session.jsonl'), undefined, createWebChannel()).ready;

		expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('id="composer"');
	});
});
