/**
 * Core types shared across the service.
 *
 * The central abstraction is {@link Channel}: a way for the owner to reach the
 * agent and for the agent to reach back. Everything above the channel layer
 * deals in {@link AgentEvent}s and knows nothing about WhatsApp or email, which
 * is what lets the acceptance tests swap in a fake channel.
 */

/** Where an event came from, and where a reply should go. */
export type ChannelId = string;

/**
 * One inbound message, or one scheduled firing, normalised across channels.
 */
export type AgentEvent = {
	/**
	 * Stable unique id. For messages this is the channel's own message id, which
	 * is what makes at-most-once delivery work across restarts (F5).
	 */
	id: string;

	/**
	 * Which channel produced this, 'schedule' for cron firings, or 'system' for
	 * the service telling the agent about its own health (e.g. a channel whose
	 * polls keep failing). A 'system' event has no reply thread.
	 */
	channel: ChannelId;

	/**
	 * Opaque conversation/thread handle within the channel, used to route the
	 * reply back to where the message came from (F1). For email this is the
	 * thread id; for WhatsApp the chat JID.
	 */
	threadId: string;

	/** Message body, or the configured prompt for a scheduled event. */
	text: string;

	/** When the underlying message was sent (not when we noticed it). */
	timestamp: Date;

	/**
	 * Human-readable sender, for the agent's benefit only. Never used for
	 * access control: the channel decides whether an event is from the owner
	 * before it is ever constructed (S1).
	 */
	sender?: string | undefined;

	/**
	 * The owner's note for the watch this event came through, if any. Trusted
	 * instruction (it comes from config, not from the message), so the runner
	 * presents it outside the data fence.
	 */
	note?: string | undefined;

	/**
	 * Channel-authored description of media attached to the message, including
	 * whatever the agent needs to fetch the actual bytes (tool name, ids).
	 * Harness-generated, never message content, so the runner presents it
	 * outside the data fence — a body claiming an attachment stays data.
	 */
	attachment?: string | undefined;
};

/** An outbound message the agent wants sent. */
export type OutboundMessage = {
	channel: ChannelId;
	threadId: string;
	text: string;
};

/**
 * A way in and out. Implementations poll their underlying MCP server and are
 * responsible for filtering to the owner (S1) — events reaching the dispatcher
 * are already trusted to be owner-originated.
 */
export type Channel = {
	id: ChannelId;

	/**
	 * Return owner-originated messages not previously returned. Implementations
	 * persist their own cursor so nothing is lost or replayed across restarts
	 * (F6); the dispatcher additionally deduplicates on {@link AgentEvent.id}.
	 */
	poll: () => Promise<AgentEvent[]>;

	/** Deliver a reply. */
	send: (message: OutboundMessage) => Promise<void>;

	/**
	 * Acknowledge events as received, for channels that have such a notion —
	 * WhatsApp's blue ticks, say. Called after the events have been handed to
	 * the agent, so the receipt means the agent has the message rather than
	 * merely that the harness fetched it.
	 *
	 * Optional, because most channels have nothing to acknowledge. Failures are
	 * logged and otherwise ignored: a missing receipt is a cosmetic loss, and
	 * not worth failing a run over.
	 */
	markRead?: ((events: AgentEvent[]) => Promise<void>) | undefined;
};

/**
 * A chat kept rather than discarded, and the owner's note about why. The note
 * is deliberately unstructured: it is owner-authored prose interpreted by the
 * agent, not configuration interpreted by the harness.
 */
export type WatchEntry = {
	/** Channel-specific selector — for WhatsApp, the chat JID. */
	chatJid: string;
	note?: string | undefined;
};

/** A cron entry: a schedule, and the prompt to run when it fires. */
export type ScheduleEntry = {
	id: string;
	/** Standard 5-field cron expression. */
	cron: string;
	prompt: string;
};

export type Config = {
	/** Fixed id for the agent's one continuous conversation (F2). */
	sessionId: string;

	/** Prepended to the agent's system prompt. Where behavioural limits live. */
	systemPrompt: string;

	/** Claude Code model. Pinned so it does not depend on when the session began. */
	model: string;

	/** Retried on once if `model` declines to answer at all. Omit to disable. */
	fallbackModel?: string | undefined;

	/**
	 * call-mcp server name for every tool call (polling, sending, media). Omit
	 * for `Aggregator`, the owner's claude.ai connector, which call-mcp resolves
	 * through claude.ai on every call (~1.9s each, and down whenever that lookup
	 * is). A config-file server such as `homelab` talks to the gateway directly
	 * on its own credential (~0.6s, 2026-08-23).
	 */
	mcpServer?: string | undefined;

	/** Directory Claude Code runs in — the agent's own repo, so it can edit itself (M1, M2). */
	workingDirectory: string;

	channels: {
		whatsapp?: {
			/**
			 * The owner's JIDs. Only messages from these are acted on (S1, S3).
			 * WhatsApp surfaces the same person under both a phone-number JID
			 * (`…@s.whatsapp.net`) and a linked-device JID (`…@lid`), so list
			 * both. The first entry is the primary: proactive messages go there.
			 */
			ownerJids: string[];
			/** MCP server backing this channel; defaults to `whatsapp`. */
			toolPrefix?: string | undefined;
			/**
			 * Chats the agent listens to without taking instructions from (S1
			 * still holds: their content is data). The harness's whole job here
			 * is not discarding these rows and stapling the note on; what to do
			 * about them is decided by the agent reading the note.
			 */
			watches?: WatchEntry[];
		};
		email?: {
			/** The owner's email address. Only mail from here is acted on (S1, S3). */
			ownerAddress: string;
			/** Gmail search fragment identifying unhandled mail. */
			query?: string;
		};
	};

	schedule: ScheduleEntry[];

	/**
	 * IANA zone the cron expressions are written in, e.g. `Europe/London`.
	 * Defaults to the system zone — which in a container is usually UTC, so a
	 * schedule meant in local time should set this.
	 */
	timezone?: string | undefined;

	polling: {
		/** Cadence when nothing has happened recently, in ms. */
		idleIntervalMs: number;
		/** Cadence shortly after activity, in ms. */
		activeIntervalMs: number;
		/** How long to stay on the fast cadence after activity, in ms. */
		activeWindowMs: number;
	};

	/**
	 * Read-only web view of the transcript. Started in-process so it lives and
	 * dies with the agent — run separately it just disappears at the next
	 * restart, which is exactly what happened to it.
	 */
	viewer: {
		enabled: boolean;
		port: number;
	};
};
