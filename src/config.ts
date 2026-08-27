/**
 * Config loading, with a last-known-good fallback.
 *
 * M4: a config the agent breaks must not leave it dead and unable to fix
 * itself. On a bad load we fall back to the last config that worked, so the
 * agent stays reachable and can be told to repair the file.
 */
import {
	readFileSync, writeFileSync, existsSync, copyFileSync,
} from 'node:fs';
import {randomUUID} from 'node:crypto';
import type {Config} from './types.js';

// The agent's instructions live in CLAUDE.md at the repo root (committed,
// public) and CLAUDE.local.md (gitignored, personal data), which Claude Code
// loads itself from the working directory. There is no system prompt here.
/** Fable 5: the most capable of the current line. */
export const DEFAULT_MODEL = 'claude-fable-5';

const FALLBACK_SUFFIX = '.last-good';

export function defaultConfig(): Config {
	return {
		sessionId: randomUUID(),
		model: DEFAULT_MODEL,
		workingDirectory: process.cwd(),
		channels: {},
		schedule: [],
		// Polls read the bridge's local SQLite, not WhatsApp — the only cost is
		// proxy latency (~1.7s/call via mcp-proxy.anthropic.com), which Adam has
		// decided he is happy to spend for responsiveness. So there is no longer
		// a reason to back off when idle: one cadence, always fast. The
		// idle/active split is kept configurable rather than removed, since a
		// direct gateway connection later may make other tradeoffs sensible.
		polling: {
			idleIntervalMs: 1000,
			activeIntervalMs: 1000,
			activeWindowMs: 120_000,
		},
		viewer: {
			enabled: true,
			port: 4317,
		},
	};
}

export type LoadResult = {
	config: Config;
	/** Set when the primary config failed and the fallback was used (M4). */
	warning?: string;
};

export function loadConfig(path: string): LoadResult {
	try {
		const config = parse(readFileSync(path, 'utf8'));
		// Only snapshot configs that actually parsed.
		copyFileSync(path, `${path}${FALLBACK_SUFFIX}`);
		return {config};
	} catch (error) {
		const fallbackPath = `${path}${FALLBACK_SUFFIX}`;
		if (existsSync(fallbackPath)) {
			try {
				return {
					config: parse(readFileSync(fallbackPath, 'utf8')),
					warning: `Config at ${path} failed to load (${describe(error)}). Running on the last known good config; the broken file has not been changed.`,
				};
			} catch {
				// Fall through to defaults.
			}
		}

		return {
			config: defaultConfig(),
			warning: `Config at ${path} failed to load (${describe(error)}) and no known-good fallback exists. Running on defaults with no channels configured.`,
		};
	}
}

export function writeConfig(path: string, config: Config): void {
	writeFileSync(path, `${JSON.stringify(config, undefined, '\t')}\n`);
}

function parse(raw: string): Config {
	const parsed = JSON.parse(raw) as Partial<Config>;

	if (typeof parsed.sessionId !== 'string' || parsed.sessionId === '') {
		throw new Error('sessionId must be a non-empty string');
	}

	if (typeof parsed.workingDirectory !== 'string' || parsed.workingDirectory === '') {
		throw new Error('workingDirectory must be a non-empty string');
	}

	const base = defaultConfig();

	return {
		sessionId: parsed.sessionId,
		workingDirectory: parsed.workingDirectory,
		channels: parsed.channels ?? {},
		schedule: Array.isArray(parsed.schedule) ? parsed.schedule : [],
		timezone: typeof parsed.timezone === 'string' && parsed.timezone.trim() !== '' ? parsed.timezone : undefined,
		model: typeof parsed.model === 'string' && parsed.model.trim() !== '' ? parsed.model : base.model,
		fallbackModel: typeof parsed.fallbackModel === 'string' && parsed.fallbackModel.trim() !== '' ? parsed.fallbackModel : undefined,
		mcpServer: typeof parsed.mcpServer === 'string' && parsed.mcpServer.trim() !== '' ? parsed.mcpServer : undefined,
		polling: {...base.polling, ...parsed.polling},
		viewer: {...base.viewer, ...parsed.viewer},
	};
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
