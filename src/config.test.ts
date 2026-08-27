import {
	describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	loadConfig, defaultConfig, writeConfig,
} from './config.js';

let directory: string;
let configPath: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'agent-config-'));
	configPath = join(directory, 'agent.config.json');
});

afterEach(() => {
	rmSync(directory, {recursive: true, force: true});
});

describe('config loading', () => {
	test('loads a valid config', () => {
		writeConfig(configPath, {...defaultConfig(), sessionId: 'abc'});
		const {config, warning} = loadConfig(configPath);
		expect(config.sessionId).toBe('abc');
		expect(warning).toBeUndefined();
	});

	// M4: the agent can break its own config; that must not kill it.
	test('falls back to last known good when the config breaks', () => {
		writeConfig(configPath, {...defaultConfig(), sessionId: 'good'});
		loadConfig(configPath); // snapshots the good copy

		writeFileSync(configPath, '{ this is not json');
		const {config, warning} = loadConfig(configPath);

		expect(config.sessionId).toBe('good');
		expect(warning).toMatch(/last known good/i);
	});

	test('falls back on a structurally invalid config', () => {
		writeConfig(configPath, {...defaultConfig(), sessionId: 'good'});
		loadConfig(configPath);

		writeFileSync(configPath, JSON.stringify({sessionId: ''}));
		const {config, warning} = loadConfig(configPath);

		expect(config.sessionId).toBe('good');
		expect(warning).toBeDefined();
	});

	test('uses defaults when there is no config and no fallback', () => {
		const {config, warning} = loadConfig(configPath);
		expect(config.channels).toEqual({});
		expect(warning).toMatch(/defaults/i);
	});

	test('does not overwrite the good snapshot with a broken config', () => {
		writeConfig(configPath, {...defaultConfig(), sessionId: 'good'});
		loadConfig(configPath);

		writeFileSync(configPath, 'broken');
		loadConfig(configPath);
		// Still recoverable on a subsequent load.
		expect(loadConfig(configPath).config.sessionId).toBe('good');
	});
});

describe('mcpServer', () => {
	test('is passed through when set', () => {
		writeConfig(configPath, {...defaultConfig(), sessionId: 'abc', mcpServer: 'homelab'});
		expect(loadConfig(configPath).config.mcpServer).toBe('homelab');
	});

	// Unset means call-mcp's default server, not an empty name it cannot resolve.
	test('an empty value is treated as unset', () => {
		writeConfig(configPath, {...defaultConfig(), sessionId: 'abc', mcpServer: '  '});
		expect(loadConfig(configPath).config.mcpServer).toBeUndefined();
	});
});
