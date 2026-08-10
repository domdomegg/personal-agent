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
	server?: string;
	binary?: string;
	/** Generous: some connectors are slow, and a stuck poll is better than a wrong one. */
	timeoutMs?: number;
};

export function createMcpCaller(options: McpOptions = {}): McpCaller {
	const server = options.server ?? 'Aggregator';
	const binary = options.binary ?? 'call-mcp';
	const timeout = options.timeoutMs ?? 60_000;

	return async (tool, args) => {
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
}
