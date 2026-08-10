import {describe, test, expect} from 'vitest';
import {
	mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMcpCaller} from './mcp.js';

/** A stub standing in for `call-mcp`, printing whatever we want on stdout. */
function stubBinary(stdout: string, exitCode = 0): string {
	const directory = mkdtempSync(join(tmpdir(), 'mcp-stub-'));
	const path = join(directory, 'call-mcp-stub');
	writeFileSync(path, `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\nexit ${exitCode}\n`);
	chmodSync(path, 0o755);
	return path;
}

describe('createMcpCaller', () => {
	// Several WhatsApp tools return `"error": null` alongside `"success": true`.
	// Treating the presence of the key as failure made every successful send
	// look like an error.
	test('treats a null error field as success', async () => {
		const call = createMcpCaller({
			binary: stubBinary('{"success":true,"message_id":"abc","error":null}'),
		});

		await expect(call('whatsapp__send_message', {})).resolves.toEqual({
			success: true,
			message_id: 'abc',
			error: null,
		});
	});

	test('throws on a real error field', async () => {
		const call = createMcpCaller({
			binary: stubBinary('{"error":"connector is down"}'),
		});

		await expect(call('whatsapp__send_message', {})).rejects.toThrow(/connector is down/);
	});

	test('parses an ordinary response', async () => {
		const call = createMcpCaller({binary: stubBinary('{"result":[1,2,3]}')});
		await expect(call('whatsapp__list_messages', {})).resolves.toEqual({result: [1, 2, 3]});
	});

	describe('expired credential', () => {
		/**
		 * Fails with the expiry message until the marker file exists, then
		 * succeeds — standing in for a credential that a `claude` run renews.
		 */
		function expiringStub(marker: string): string {
			const directory = mkdtempSync(join(tmpdir(), 'mcp-stub-'));
			const path = join(directory, 'call-mcp-stub');
			writeFileSync(path, [
				'#!/bin/sh',
				`if [ -f "${marker}" ]; then`,
				'  echo \'{"result":["recovered"]}\'',
				'  exit 0',
				'fi',
				'echo \'{"error":"The Claude Code token expired 11 minute(s) ago."}\'',
				'exit 1',
			].join('\n'));
			chmodSync(path, 0o755);
			return path;
		}

		/** Stands in for `claude`, whose startup is what renews the credential. */
		function renewerStub(marker: string, countFile: string): string {
			const directory = mkdtempSync(join(tmpdir(), 'claude-stub-'));
			const path = join(directory, 'claude-stub');
			writeFileSync(path, `#!/bin/sh\necho x >> "${countFile}"\ntouch "${marker}"\n`);
			chmodSync(path, 0o755);
			return path;
		}

		test('renews the credential and retries', async () => {
			const directory = mkdtempSync(join(tmpdir(), 'mcp-marker-'));
			const marker = join(directory, 'renewed');
			const countFile = join(directory, 'runs');

			const logged: string[] = [];
			const call = createMcpCaller({
				binary: expiringStub(marker),
				claudePath: renewerStub(marker, countFile),
				log(message) {
					logged.push(message);
				},
			});

			await expect(call('whatsapp__list_messages', {})).resolves.toEqual({result: ['recovered']});
			expect(logged).toContain('mcp credential expired, renewing');
		});

		// At a 1s poll interval an expired credential fails many calls at once.
		// Each one launching its own Claude Code process would be a stampede.
		test('renews once for concurrent failures', async () => {
			const directory = mkdtempSync(join(tmpdir(), 'mcp-marker-'));
			const marker = join(directory, 'renewed');
			const countFile = join(directory, 'runs');

			const call = createMcpCaller({
				binary: expiringStub(marker),
				claudePath: renewerStub(marker, countFile),
			});

			await Promise.all([
				call('whatsapp__list_messages', {}),
				call('whatsapp__list_messages', {}),
				call('whatsapp__list_messages', {}),
			]);

			expect(readFileSync(countFile, 'utf8').trim().split('\n')).toHaveLength(1);
		});

		// Renewing on any old failure would launch a process every time a
		// connector was merely down, which is the common case.
		test('does not renew for an unrelated failure', async () => {
			const directory = mkdtempSync(join(tmpdir(), 'mcp-marker-'));
			const countFile = join(directory, 'runs');

			const call = createMcpCaller({
				binary: stubBinary('{"error":"connector is down"}'),
				claudePath: renewerStub(join(directory, 'unused'), countFile),
			});

			await expect(call('whatsapp__list_messages', {})).rejects.toThrow(/connector is down/);
			expect(existsSync(countFile)).toBe(false);
		});
	});

	test('throws on non-JSON output', async () => {
		const call = createMcpCaller({binary: stubBinary('not json at all')});
		await expect(call('anything', {})).rejects.toThrow(/Non-JSON response/);
	});
});
