/**
 * Standalone entry point for the viewer prototypes.
 *
 *   node dist/viewer/main.js [transcriptPath] [port]
 *
 * Defaults to the newest transcript for this project, which is the session the
 * agent is running in.
 */
import {
	existsSync, readdirSync, realpathSync, statSync,
} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {startViewer} from './server.js';

export function newestTranscript(cwd = process.cwd()): string {
	// Claude Code slugifies the project path into the directory name.
	const projects = join(homedir(), '.claude', 'projects');
	const slug = cwd.replaceAll('/', '-');
	const directory = join(projects, slug);

	const files = readdirSync(directory)
		.filter((name) => name.endsWith('.jsonl'))
		.map((name) => {
			const path = join(directory, name);
			return {path, at: statSync(path).mtimeMs};
		})
		.sort((a, b) => b.at - a.at);

	if (files.length === 0) {
		throw new Error(`no transcripts in ${directory}`);
	}

	return files[0]!.path;
}

const PROJECTS = join(homedir(), '.claude', 'projects');

/** Claude Code slugifies the project path into the directory name. */
function projectDirectory(cwd: string, projects: string): string {
	return join(projects, cwd.replaceAll('/', '-'));
}

/**
 * The transcript for a known session, which the agent can name exactly.
 *
 * Claude Code derives the projects/ subdirectory from the session's cwd, and
 * it resolves symlinks first: with workingDirectory set to a symlink
 * (/home/agent/personal-agent -> /home/agent/src/personal-agent) the literal
 * slug stopped matching on 2026-10-18 and the viewer watched a file that never
 * appeared, so the page showed nothing for four days. Prefer the real path,
 * accept the literal one, and otherwise find the file by session id.
 */
export function transcriptForSession(sessionId: string, cwd = process.cwd(), projects = PROJECTS): string {
	const literal = projectDirectory(cwd, projects);
	let real = literal;
	try {
		real = projectDirectory(realpathSync(cwd), projects);
	} catch {
		// cwd does not exist (yet): the literal slug is the only guess.
	}

	const file = `${sessionId}.jsonl`;
	for (const directory of [real, literal]) {
		if (existsSync(join(directory, file))) {
			return join(directory, file);
		}
	}

	return locateTranscript(sessionId, projects) ?? join(real, file);
}

/** Finds a session's transcript under any project directory, by its id alone. */
export function locateTranscript(sessionId: string, projects = PROJECTS): string | undefined {
	let names: string[];
	try {
		names = readdirSync(projects);
	} catch {
		return undefined;
	}

	for (const name of names) {
		const candidate = join(projects, name, `${sessionId}.jsonl`);
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

// Only when run directly. The agent imports transcriptForSession from here and
// starts the viewer itself, which must not also spawn one on import.
if (process.argv[1]?.endsWith('viewer/main.js')) {
	const path = process.argv[2] ?? newestTranscript();
	const port = Number(process.argv[3] ?? 4317);

	startViewer({transcriptPath: path, port});

	process.stdout.write(`viewer on http://localhost:${port}\n  transcript: ${path}\n`);
}
