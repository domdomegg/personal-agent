import {
	describe, test, expect, afterEach,
} from 'vitest';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer, type Server} from 'node:http';
import {connect} from 'node:net';
import {startViewer} from './server.js';

// A fresh session has no transcript, and often no projects/ directory either:
// Claude Code writes both on the first turn. The viewer used to watch the file
// directly, so it threw ENOENT and stayed dead for exactly the session you most
// want to watch.
const viewers: {close: () => void}[] = [];
const directories: string[] = [];

function start(transcriptPath: string, desktopPort?: number): ReturnType<typeof startViewer> {
	// Port 0 lets the OS pick a free one, so tests never clash.
	const viewer = startViewer({transcriptPath, port: 0, desktopPort});
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
