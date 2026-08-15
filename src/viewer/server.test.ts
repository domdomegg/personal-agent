import {
	describe, test, expect, afterEach,
} from 'vitest';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startViewer} from './server.js';

// A fresh session has no transcript, and often no projects/ directory either:
// Claude Code writes both on the first turn. The viewer used to watch the file
// directly, so it threw ENOENT and stayed dead for exactly the session you most
// want to watch.
const viewers: {close: () => void}[] = [];
const directories: string[] = [];

function start(transcriptPath: string): {close: () => void} {
	// Port 0 lets the OS pick a free one, so tests never clash.
	const viewer = startViewer({transcriptPath, port: 0});
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
