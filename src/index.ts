/**
 * Assembles the agent from its parts.
 *
 * Deliberately small: Claude Code is the agent, the MCP servers are the
 * capabilities, and this is only the push path that wakes them.
 */
import {existsSync, writeFileSync} from 'node:fs';
import type {Channel, Config} from './types.js';
import {Runner} from './runner.js';
import {Dispatcher} from './dispatcher.js';
import {Scheduler} from './scheduler.js';
import {createMcpCaller, type McpCaller} from './mcp.js';
import {createWhatsappChannel, WHATSAPP_CHANNEL_ID} from './channels/whatsapp.js';
import {startViewer} from './viewer/server.js';
import {transcriptForSession} from './viewer/main.js';
import {createEmailChannel} from './channels/email.js';

export type * from './types.js';
export {Runner} from './runner.js';
export {Dispatcher} from './dispatcher.js';
export {Scheduler} from './scheduler.js';
export {
	loadConfig, writeConfig, defaultConfig, DEFAULT_SYSTEM_PROMPT,
} from './config.js';
export {createMcpCaller} from './mcp.js';

export type AgentOptions = {
	config: Config;
	statePath: string;
	/** Tests pass fakes; otherwise built from config. */
	channels?: Channel[] | undefined;
	call?: McpCaller | undefined;
	claudePath?: string | undefined;
	lingerMs?: number | undefined;
	sessionExists?: boolean | undefined;
	log?: ((message: string, detail?: unknown) => void) | undefined;
};

export type Agent = {
	runner: Runner;
	dispatcher: Dispatcher;
	scheduler: Scheduler;
	channels: Channel[];
	start: () => void;
	stop: () => void;
	/** Waits for in-flight sends to be acknowledged, so their ids are durable. */
	drain: (timeoutMs?: number) => Promise<void>;
};

function noop(): void {
	// Logging is optional.
}

export function createAgent(options: AgentOptions): Agent {
	const {config} = options;
	const log = options.log ?? noop;
	const call = options.call ?? createMcpCaller({log, server: config.mcpServer});

	// The dispatcher owns durable state, and channels read their cursors from
	// it — but it needs the channels to construct. Indirect through a holder so
	// the cycle resolves without either needing to exist first.
	// Records that the Claude Code session has been created, so a later process
	// resumes it instead of failing with "Session ID is already in use".
	const sessionMarker = `${options.statePath}.session`;

	const holder: {dispatcher?: Dispatcher; runner?: Runner} = {};

	let viewer: {close: () => void} | undefined;

	const channels = options.channels ?? buildChannels(config, call, {
		getCursor: (id) => holder.dispatcher?.getCursor(id),
		setCursor(id, cursor) {
			holder.dispatcher?.setCursor(id, cursor);
		},
		markSeen(id) {
			holder.dispatcher?.markSeen(id);
		},
		wasSeen: (id) => holder.dispatcher?.hasSeen(id) ?? false,
	}, (channelId, threadId) => {
		// The agent's own send, seen coming back around in a poll: tell the
		// runner the thread has been answered, so the reply-check stands down.
		holder.runner?.noteReplySent(channelId, threadId);
	});

	const runner = new Runner({
		sessionId: config.sessionId,
		systemPrompt: config.systemPrompt,
		model: config.model,
		fallbackModel: config.fallbackModel,
		workingDirectory: config.workingDirectory,
		claudePath: options.claudePath,
		lingerMs: options.lingerMs,
		sessionExists: options.sessionExists ?? existsSync(sessionMarker),
		// Recorded only once a run has actually created the session. Writing it
		// at startup meant the first real run tried to --resume a session that
		// had never been created, and failed with "No conversation found".
		onSessionCreated() {
			if (!existsSync(sessionMarker)) {
				writeFileSync(sessionMarker, config.sessionId);
			}
		},
		log,
	});

	holder.runner = runner;

	const dispatcher = new Dispatcher({
		channels,
		runner,
		statePath: options.statePath,
		polling: config.polling,
		log,
	});

	holder.dispatcher = dispatcher;

	const scheduler = new Scheduler({
		entries: config.schedule,
		timezone: config.timezone,
		log,
		async onFire(event) {
			if (dispatcher.hasSeen(event.id)) {
				return;
			}

			dispatcher.markSeen(event.id);
			await runner.submit(event);
		},
	});

	return {
		runner,
		dispatcher,
		scheduler,
		channels,
		start() {
			dispatcher.start();
			scheduler.start();

			if (config.viewer.enabled) {
				try {
					viewer = startViewer({
						transcriptPath: transcriptForSession(config.sessionId, config.workingDirectory),
						port: config.viewer.port,
					});
					log('viewer started', {port: config.viewer.port});
				} catch (error) {
					// A port clash or missing transcript must not stop the agent
					// coming up — the viewer is only for watching.
					log('viewer failed to start', error);
				}
			}

			log('started', {channels: channels.map((c) => c.id)});
		},
		stop() {
			dispatcher.stop();
			scheduler.stop();
			runner.stop();
			viewer?.close();
			viewer = undefined;
		},
		/**
		 * Nothing to settle since the agent took over its own sends (they go
		 * over MCP within a run, not through this process): kept because the
		 * shutdown path calls it, and future channels may queue work again.
		 */
		async drain(): Promise<void> {
			// Intentionally immediate.
		},
	};
}

export type CursorStore = {
	getCursor: (channel: string) => string | undefined;
	setCursor: (channel: string, cursor: string) => void;
	/** Durably records a handled id, so a restart does not reprocess it. */
	markSeen: (id: string) => void;
	/** Whether an id was already handled, including before a restart. */
	wasSeen: (id: string) => boolean;
};

function buildChannels(
	config: Config,
	call: McpCaller,
	cursors: CursorStore,
	onOwnMessage?: (channelId: string, threadId: string) => void,
): Channel[] {
	const channels: Channel[] = [];

	if (config.channels.whatsapp) {
		channels.push(createWhatsappChannel({
			call,
			cursors,
			ownerJids: config.channels.whatsapp.ownerJids,
			toolPrefix: config.channels.whatsapp.toolPrefix,
			watches: config.channels.whatsapp.watches,
			onOwnMessage: onOwnMessage && ((threadId) => {
				onOwnMessage(WHATSAPP_CHANNEL_ID, threadId);
			}),
		}));
	}

	if (config.channels.email) {
		channels.push(createEmailChannel({
			call,
			ownerAddress: config.channels.email.ownerAddress,
			query: config.channels.email.query,
		}));
	}

	return channels;
}
