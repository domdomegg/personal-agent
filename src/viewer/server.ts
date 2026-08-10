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
import {createServer} from 'node:http';
import {watch} from 'node:fs';
import {readTranscript, type Entry} from './transcript.js';
import {streamPage} from './stream.js';

export type ViewerOptions = {
	transcriptPath: string;
	port: number;
};

export function startViewer(options: ViewerOptions): {close: () => void} {
	// Bumped on every file change; clients poll it to know when to refetch.
	let version = 0;
	const watcher = watch(options.transcriptPath, () => {
		version += 1;
	});

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? '/', 'http://localhost');

		const send = (status: number, type: string, body: string): void => {
			response.writeHead(status, {'content-type': type, 'cache-control': 'no-store'});
			response.end(body);
		};

		if (url.pathname === '/api/version') {
			send(200, 'application/json', JSON.stringify({version}));
			return;
		}

		if (url.pathname === '/api/entries') {
			readTranscript(options.transcriptPath)
				.then((entries) => {
					send(200, 'application/json', JSON.stringify({version, entries}));
				})
				.catch((error: unknown) => {
					send(500, 'application/json', JSON.stringify({error: String(error)}));
				});
			return;
		}

		// /stream kept as an alias so existing tabs and bookmarks still work.
		if (url.pathname === '/' || url.pathname === '/stream') {
			send(200, 'text/html; charset=utf-8', streamPage());
			return;
		}

		send(404, 'text/plain', 'not found');
	});

	server.listen(options.port);

	return {
		close(): void {
			watcher.close();
			server.close();
		},
	};
}

export type {Entry};
