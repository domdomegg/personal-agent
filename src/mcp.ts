/**
 * Thin wrapper over the `call-mcp` CLI.
 *
 * Using the CLI rather than an MCP client library keeps this service out of the
 * business of connector auth: `call-mcp` already resolves the owner's
 * credentials the same way the rest of their tooling does.
 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

export type McpCaller = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export type McpOptions = {
	server?: string | undefined;
	binary?: string;
	/** Generous: some connectors are slow, and a stuck poll is better than a wrong one. */
	timeoutMs?: number;
	/** Run once to renew an expired credential. Overridable so tests can stub it. */
	claudePath?: string;
	log?: (message: string, detail?: unknown) => void;
};

/**
 * `call-mcp` borrows the owner's Claude Code OAuth credential, which expires
 * every few hours. Detected on the error text because the failure surfaces two
 * different ways — as a thrown `{error: ...}` payload, or as a non-zero exit
 * with the JSON on stdout.
 */
function isExpiredCredential(error: unknown): boolean {
	const parts: string[] = [];
	if (error instanceof Error) {
		parts.push(error.message);
	}

	const {stdout, stderr} = (error ?? {}) as {stdout?: unknown; stderr?: unknown};
	if (typeof stdout === 'string') {
		parts.push(stdout);
	}

	if (typeof stderr === 'string') {
		parts.push(stderr);
	}

	return parts.join(' ').toLowerCase().includes('token expired');
}

export function createMcpCaller(options: McpOptions = {}): McpCaller {
	const server = options.server ?? 'Aggregator';
	const binary = options.binary ?? 'call-mcp';
	const timeout = options.timeoutMs ?? 60_000;
	const claudePath = options.claudePath ?? 'claude';

	// Starting Claude Code is what renews the credential — there is no separate
	// refresh command — so this is a throwaway run whose only purpose is its
	// own startup. Cheapest model, one-word prompt.
	//
	// Shared, because at a 1s poll interval a dead credential produces a great
	// many simultaneous failures, and they must not each launch a process.
	let refreshing: Promise<void> | undefined;
	const renewCredential = async (): Promise<void> => {
		refreshing ??= execFileAsync(
			claudePath,
			['-p', '--model', 'claude-haiku-4-5-20251001', 'ok'],
			{timeout: 120_000},
		).then(
			() => undefined,
			// A failed renewal is not itself interesting: the retry below will
			// surface the original error, which describes the real problem.
			() => undefined,
		).finally(() => {
			refreshing = undefined;
		});

		return refreshing;
	};

	const invoke = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
		const {stdout} = await execFileAsync(
			binary,
			['call', server, tool, '--args', JSON.stringify(args)],
			{timeout, maxBuffer: 32 * 1024 * 1024},
		);

		const trimmed = stdout.trim();
		if (trimmed === '') {
			return undefined;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// call-mcp prints JSON on success and on error, so this means
			// something unexpected happened upstream.
			throw new Error(`Non-JSON response from ${tool}: ${trimmed.slice(0, 500)}`);
		}

		// call-mcp reports failures as {error: ...} with a non-zero exit, but
		// execFile only throws on the exit code — check the shape too.
		//
		// Only a non-null error counts. Several tools include `"error": null`
		// alongside `"success": true` on a perfectly good response, so keying on
		// the presence of the property would treat every success as a failure.
		if (typeof parsed === 'object' && parsed !== null) {
			const {error} = parsed as {error?: unknown};
			if (error !== undefined && error !== null) {
				throw new Error(`${tool} failed: ${JSON.stringify(error).slice(0, 500)}`);
			}
		}

		return parsed;
	};

	return async (tool, args) => {
		try {
			return await invoke(tool, args);
		} catch (error) {
			if (!isExpiredCredential(error)) {
				throw error;
			}

			// Worth doing here rather than leaving it to the poll-failure alert.
			// That alert wakes the agent, and starting the agent is what used to
			// renew the credential — but only if no run was already live. During
			// a long run the alert just joined it, no process started, and the
			// harness stayed blind until the run happened to end.
			options.log?.('mcp credential expired, renewing');
			await renewCredential();
			return invoke(tool, args);
		}
	};
}
