/**
 * Standalone entry point for the viewer prototypes.
 *
 *   node dist/viewer/main.js [transcriptPath] [port]
 *
 * Defaults to the newest transcript for this project, which is the session the
 * agent is running in.
 */
import {readdirSync, statSync} from 'node:fs';
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

/** The transcript for a known session, which the agent can name exactly. */
export function transcriptForSession(sessionId: string, cwd = process.cwd()): string {
	return join(homedir(), '.claude', 'projects', cwd.replaceAll('/', '-'), `${sessionId}.jsonl`);
}

// Only when run directly. The agent imports transcriptForSession from here and
// starts the viewer itself, which must not also spawn one on import.
if (process.argv[1]?.endsWith('viewer/main.js')) {
	const path = process.argv[2] ?? newestTranscript();
	const port = Number(process.argv[3] ?? 4317);

	startViewer({transcriptPath: path, port});

	process.stdout.write(`viewer on http://localhost:${port}\n  transcript: ${path}\n`);
}
