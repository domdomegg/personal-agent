/**
 * Transcript viewer: every tool call, note and reply as it happens.
 *
 * There was a second, conversation-shaped view alongside this one. It was
 * dropped: WhatsApp already is that view, and filtering this one to
 * adam + reply reproduces it from the same data without a second renderer.
 *
 * Deliberately dependency-free, and polling rather than websockets — the
 * transcript is a file on disk, so watching it is enough.
 */
import {
	createServer, request as httpRequest, type IncomingMessage, type ServerResponse,
} from 'node:http';
import {connect as netConnect, type Socket} from 'node:net';
import {
	watch, existsSync, mkdirSync, type FSWatcher,
} from 'node:fs';
import {dirname, basename} from 'node:path';
import {hostname} from 'node:os';
import {readTranscript, readImage, type Entry} from './transcript.js';
import {streamPage} from './stream.js';
import {connectPage} from './connect.js';

export type ViewerOptions = {
	transcriptPath: string;
	port: number;
	/**
	 * Where noVNC (websockify) for the agent's desktop listens. /desktop/ is
	 * proxied to it, so the desktop shares the viewer's hostname and auth
	 * instead of needing a second Service + Ingress. Default 6080.
	 */
	desktopPort?: number | undefined;
};

export type Viewer = {
	close: () => void;
	/** Resolves with the bound port once listening (port 0 picks a free one). */
	ready: Promise<number>;
};

const DESKTOP_PREFIX = '/desktop';

/**
 * Plain HTTP pass-through for noVNC's static files. The prefix is stripped so
 * noVNC sees the paths it expects; its own links are relative, so they stay
 * under /desktop/ on the way back.
 */
function proxyDesktopHttp(request: IncomingMessage, response: ServerResponse, desktopPort: number): void {
	const upstream = httpRequest({
		host: '127.0.0.1',
		port: desktopPort,
		method: request.method,
		path: (request.url ?? '/').slice(DESKTOP_PREFIX.length) || '/',
		headers: {...request.headers, host: `127.0.0.1:${desktopPort}`},
	}, (upstreamResponse) => {
		response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
		upstreamResponse.pipe(response);
	});
	upstream.on('error', () => {
		response.writeHead(502, {'content-type': 'text/plain'});
		response.end(`desktop is not running: nothing answering on 127.0.0.1:${desktopPort} (desktop-start brings it up)`);
	});
	request.pipe(upstream);
}

/**
 * The VNC connection itself is a WebSocket. Node's http server hands upgrade
 * requests to us raw, so replay the request line and headers to websockify
 * over a plain TCP socket and splice the two sockets together. No WebSocket
 * framing is touched: both ends speak it, we only carry bytes.
 */
function proxyDesktopUpgrade(request: IncomingMessage, socket: Socket, head: Buffer, desktopPort: number): void {
	const path = (request.url ?? '/').slice(DESKTOP_PREFIX.length) || '/';
	const upstream = netConnect(desktopPort, '127.0.0.1', () => {
		const lines = [`${request.method ?? 'GET'} ${path} HTTP/1.1`];
		for (const [name, value] of Object.entries(request.headers)) {
			for (const v of Array.isArray(value) ? value : [value]) {
				if (v !== undefined) {
					lines.push(`${name}: ${v}`);
				}
			}
		}

		upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
		if (head.length > 0) {
			upstream.write(head);
		}

		upstream.pipe(socket);
		socket.pipe(upstream);
	});
	upstream.on('error', () => socket.destroy());
	socket.on('error', () => upstream.destroy());
}

export function startViewer(options: ViewerOptions): Viewer {
	const desktopPort = options.desktopPort ?? 6080;
	// Bumped on every file change; clients poll it to know when to refetch.
	// changedAt feeds the working/idle indicator: fresh writes mean a turn is
	// in progress even when no tool call is visibly unresolved.
	let version = 0;
	let changedAt = 0;

	// Claude Code writes the transcript on the session's first turn, so on a
	// fresh session there is no file — and often no projects/ directory — when
	// the agent comes up. Watching the file directly threw ENOENT and left the
	// viewer dead for the whole session, which is exactly the session you most
	// want to watch. So watch the directory and attach once the file appears.
	const directory = dirname(options.transcriptPath);
	const filename = basename(options.transcriptPath);

	let fileWatcher: FSWatcher | undefined;
	let directoryWatcher: FSWatcher | undefined;

	const watchFile = (): void => {
		fileWatcher = watch(options.transcriptPath, () => {
			version += 1;
			changedAt = Date.now();
		});
	};

	if (existsSync(options.transcriptPath)) {
		watchFile();
	} else {
		mkdirSync(directory, {recursive: true});
		directoryWatcher = watch(directory, (_event, changed) => {
			if (fileWatcher || (changed !== null && changed !== filename)) {
				return;
			}

			if (existsSync(options.transcriptPath)) {
				// The file exists now: count its arrival as a change, hand over to
				// watching it directly, and stop watching the directory.
				version += 1;
				watchFile();
				directoryWatcher?.close();
				directoryWatcher = undefined;
			}
		});
	}

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? '/', 'http://localhost');

		const send = (status: number, type: string, body: string): void => {
			response.writeHead(status, {'content-type': type, 'cache-control': 'no-store'});
			response.end(body);
		};

		if (url.pathname === '/api/version') {
			send(200, 'application/json', JSON.stringify({version, changedAt}));
			return;
		}

		// Images referenced by entries, fetched when a row is expanded. The id
		// names a specific block of a specific tool call, so the bytes never
		// change and the browser may cache them for good.
		if (url.pathname === '/api/image') {
			const id = url.searchParams.get('id') ?? '';
			if (!existsSync(options.transcriptPath)) {
				send(404, 'text/plain', 'no transcript');
				return;
			}

			readImage(options.transcriptPath, id)
				.then((image) => {
					if (!image) {
						send(404, 'text/plain', 'no such image');
						return;
					}

					response.writeHead(200, {'content-type': image.mediaType, 'cache-control': 'private, max-age=31536000, immutable'});
					response.end(image.data);
				})
				.catch((error: unknown) => {
					send(500, 'text/plain', String(error));
				});
			return;
		}

		if (url.pathname === '/api/entries') {
			// Before the first turn there is nothing to read; an empty transcript
			// is the honest answer, not a 500.
			if (!existsSync(options.transcriptPath)) {
				send(200, 'application/json', JSON.stringify({version, entries: []}));
				return;
			}

			readTranscript(options.transcriptPath)
				.then((entries) => {
					send(200, 'application/json', JSON.stringify({version, entries}));
				})
				.catch((error: unknown) => {
					send(500, 'application/json', JSON.stringify({error: String(error)}));
				});
			return;
		}

		// The agent's desktop, by way of noVNC. `path` tells noVNC where its
		// WebSocket lives, since the page is served under a prefix.
		if (url.pathname === DESKTOP_PREFIX) {
			response.writeHead(302, {location: `${DESKTOP_PREFIX}/vnc.html?autoconnect=1&resize=scale&path=desktop/websockify`});
			response.end();
			return;
		}

		if (url.pathname.startsWith(`${DESKTOP_PREFIX}/`)) {
			proxyDesktopHttp(request, response, desktopPort);
			return;
		}

		// /stream kept as an alias so existing tabs and bookmarks still work.
		if (url.pathname === '/' || url.pathname === '/stream') {
			send(200, 'text/html; charset=utf-8', streamPage());
			return;
		}

		if (url.pathname === '/connect') {
			// The pod name is the hostname, so the page stays correct across
			// rollouts without any config.
			send(200, 'text/html; charset=utf-8', connectPage({
				podName: hostname(),
				namespace: 'default',
				container: 'personal-agent',
			}));
			return;
		}

		send(404, 'text/plain', 'not found');
	});

	server.on('upgrade', (request, socket, head) => {
		if (request.url?.startsWith(`${DESKTOP_PREFIX}/`)) {
			proxyDesktopUpgrade(request, socket as Socket, head, desktopPort);
			return;
		}

		socket.destroy();
	});

	const ready = new Promise<number>((resolve) => {
		server.once('listening', () => {
			const address = server.address();
			resolve(typeof address === 'object' && address !== null ? address.port : options.port);
		});
	});
	server.listen(options.port);

	return {
		ready,
		close(): void {
			fileWatcher?.close();
			directoryWatcher?.close();
			server.close();
		},
	};
}

export type {Entry};
