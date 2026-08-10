import {describe, test, expect} from 'vitest';
import {mkdtempSync, writeFileSync, chmodSync} from 'node:fs';
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

	test('throws on non-JSON output', async () => {
		const call = createMcpCaller({binary: stubBinary('not json at all')});
		await expect(call('anything', {})).rejects.toThrow(/Non-JSON response/);
	});
});
