import {
	describe, test, expect, afterEach,
} from 'vitest';
import {
	mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {locateTranscript, transcriptForSession} from './main.js';

// Claude Code names the projects/ subdirectory after the session's cwd, with
// symlinks resolved. The agent's workingDirectory is a symlink, so a transcript
// path built from the literal string pointed at a file that never appeared and
// the viewer stayed empty for four days (2026-10-18 to 10-22).
const directories: string[] = [];

function scratch(): string {
	const directory = mkdtempSync(join(tmpdir(), 'viewer-main-test-'));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	while (directories.length > 0) {
		const directory = directories.pop();
		if (directory) {
			rmSync(directory, {recursive: true, force: true});
		}
	}
});

function layout(): {projects: string; real: string; link: string} {
	const root = scratch();
	const projects = join(root, 'projects');
	const real = join(root, 'src', 'agent');
	const link = join(root, 'agent');
	mkdirSync(real, {recursive: true});
	mkdirSync(projects, {recursive: true});
	symlinkSync(real, link);
	return {projects, real, link};
}

const slug = (path: string): string => path.replaceAll('/', '-');

describe('transcriptForSession', () => {
	test('prefers the directory named after the resolved real path', () => {
		const {projects, real, link} = layout();
		const expected = join(projects, slug(real), 'abc.jsonl');
		mkdirSync(join(projects, slug(real)));
		writeFileSync(expected, '');
		mkdirSync(join(projects, slug(link)));
		writeFileSync(join(projects, slug(link), 'abc.jsonl'), '');

		expect(transcriptForSession('abc', link, projects)).toBe(expected);
	});

	test('accepts the literal, unresolved path when that is where the file is', () => {
		const {projects, link} = layout();
		const expected = join(projects, slug(link), 'abc.jsonl');
		mkdirSync(join(projects, slug(link)));
		writeFileSync(expected, '');

		expect(transcriptForSession('abc', link, projects)).toBe(expected);
	});

	test('finds the file by session id when it is somewhere else entirely', () => {
		const {projects, link} = layout();
		const elsewhere = join(projects, '-somewhere-else', 'abc.jsonl');
		mkdirSync(join(projects, '-somewhere-else'));
		writeFileSync(elsewhere, '');

		expect(transcriptForSession('abc', link, projects)).toBe(elsewhere);
	});

	test('guesses the real-path directory before the first turn writes anything', () => {
		const {projects, real, link} = layout();

		expect(transcriptForSession('abc', link, projects)).toBe(join(projects, slug(real), 'abc.jsonl'));
	});
});

describe('locateTranscript', () => {
	test('returns undefined when the projects directory is missing', () => {
		expect(locateTranscript('abc', join(scratch(), 'nope'))).toBeUndefined();
	});

	test('ignores other sessions', () => {
		const {projects, real} = layout();
		mkdirSync(join(projects, slug(real)));
		writeFileSync(join(projects, slug(real), 'other.jsonl'), '');

		expect(locateTranscript('abc', projects)).toBeUndefined();
	});
});
