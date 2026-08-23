/**
 * Shutdown behaviour.
 *
 * Historically this guarded runner-driven sends still in flight at shutdown:
 * the process once died moments after sending a reply, before the bridge
 * returned the id marking it as the agent's own, and the next process
 * answered that reply as if it were a new instruction. The agent now sends
 * over MCP inside its own runs — there is no service-side send queue left to
 * drain — so what remains to pin down is that drain resolves promptly and
 * shutdown leaves no state a later process would misread.
 */
import {
	describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createAgent} from './index.js';
import {defaultConfig} from './config.js';
import type {Config} from './types.js';

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'agent-drain-'));
});

afterEach(() => {
	rmSync(directory, {recursive: true, force: true});
});

describe('shutdown', () => {
	test('drain resolves immediately', async () => {
		const statePath = join(directory, 'state.json');
		const config: Config = {
			...defaultConfig(),
			sessionId: randomUUID(),
			workingDirectory: directory,
		};

		const agent = createAgent({config, statePath, channels: []});
		agent.stop();

		const start = Date.now();
		await expect(agent.drain(5000)).resolves.toBeUndefined();
		expect(Date.now() - start).toBeLessThan(1000);

		// Nothing was written that a later process would have to read back.
		expect(() => readFileSync(statePath, 'utf8')).toThrow();
	});
});
