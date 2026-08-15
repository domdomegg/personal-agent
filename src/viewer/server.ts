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
import {
	watch, existsSync, mkdirSync, type FSWatcher,
} from 'node:fs';
import {dirname, basename} from 'node:path';
import {readTranscript, type Entry} from './transcript.js';
import {streamPage} from './stream.js';

export type ViewerOptions = {
	transcriptPath: string;
	port: number;
};

export function startViewer(options: ViewerOptions): {close: () => void} {
	// Bumped on every file change; clients poll it to know when to refetch.
	let version = 0;

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
			send(200, 'application/json', JSON.stringify({version}));
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
			fileWatcher?.close();
			directoryWatcher?.close();
			server.close();
		},
	};
}

export type {Entry};
