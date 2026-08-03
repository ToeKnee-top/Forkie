// Core types for kyto's custom Slack harness. These deliberately mirror the
// shapes the old chat-sdk exposed (Message/Author/StreamChunk/ActionEvent) so
// the agent loop, tools, and features port with minimal churn.

export interface Author {
  fullName?: string;
  isBot?: boolean;
  isMe?: boolean;
  userId: string;
  userName: string;
}

export interface MessageAttachment {
  /** Raw bytes, when already fetched. */
  data?: Uint8Array;
  /** Lazily download the file (url_private with the bot token). */
  fetchData?: () => Promise<Uint8Array | null>;
  mimeType?: string;
  name?: string;
  /** Coarse kind: 'image' | 'file'. */
  type: string;
  url?: string;
}

export interface Message {
  attachments: MessageAttachment[];
  author: Author;
  /** Message ts. */
  id: string;
  isMention: boolean;
  metadata: { dateSent?: Date; edited?: boolean };
  /** Raw Slack event this message was built from. */
  raw: Record<string, unknown>;
  /** Text with Slack mrkdwn converted to markdown. */
  text: string;
  /** Harness thread id: `slack:CHANNEL:THREAD_TS`. */
  threadId: string;
}

/**
 * Native Slack streaming chunks (`chat.appendStream` `chunks` payloads). The
 * `task_update` shape is exactly what the agent's renderStream emits today.
 */
export type StreamChunk =
  | {
      details?: string;
      id: string;
      output?: string;
      status: 'complete' | 'error' | 'in_progress';
      title: string;
      type: 'task_update';
    }
  | { text: string; type: 'markdown_text' };

export interface PostFile {
  data: Uint8Array;
  filename: string;
}

/** Everything `thread.post` accepts. A plain string means markdown. */
export interface PostContent {
  /**
   * Let `<!channel>`/`<!here>`/`<!everyone>`/`<!subteam^…>` through as REAL
   * pings. Off by default: `ThreadHandle.post` strips them from every post
   * unless the caller says otherwise, so a path nobody thought of as "the model
   * talking" (a reminder body, an upload title) cannot notify a whole channel.
   * Set it only where the broadcast gate has already been checked — owner, and
   * in the channel kyto was invoked in.
   */
  allowBroadcast?: boolean;
  blocks?: unknown[];
  fallbackText?: string;
  files?: PostFile[];
  /** Per-message profile override (needs the chat:write.customize scope). */
  iconEmoji?: string;
  iconUrl?: string;
  markdown?: string;
  metadata?: { event_payload: Record<string, unknown>; event_type: string };
  username?: string;
}

export interface SentMessage {
  delete: () => Promise<void>;
  /** Message ts. */
  id: string;
  raw: unknown;
  threadId: string;
}

export interface ThreadState {
  /**
   * Focus mode: when set, kyto only responds to (and only sees) messages from
   * these Slack user ids in this thread. Null/undefined = focus off.
   */
  focusUserIds?: string[] | null;
  respondOnThreadMessages?: boolean;
}

export interface ActionEvent {
  /** Message ts of the message hosting the action, if any. */
  messageId?: string;
  raw: unknown;
  thread?: import('./thread').ThreadHandle;
  threadId: string;
  triggerId?: string;
  user: Author;
  value?: string;
}

export type ModalSubmitResult =
  | { action: 'clear' }
  | { action: 'errors'; errors: Record<string, string> }
  | undefined;

export interface ModalSubmitEvent {
  callbackId: string;
  raw: unknown;
  triggerId?: string;
  user: Author;
  /** View state values flattened by block_id (first action's value). */
  values: Record<string, string | undefined>;
}

export interface AssistantThreadEvent {
  channelId: string;
  threadTs: string;
}

export interface MemberJoinedEvent {
  channelId: string;
  /**
   * The user who invited this member, when present. Absent on a programmatic
   * self-join (e.g. `conversations.join` to search a channel), which is how we
   * tell an intentional human add apart from a silent search-join.
   */
  inviter?: string;
  userId: string;
}

export interface AppHomeEvent {
  userId: string;
}

export interface ChannelMetadata {
  channelVisibility: 'external' | 'private' | 'workspace';
  /** Raw channel id (C123…). */
  id: string;
  isDM: boolean;
  memberCount?: number;
  name?: string;
}
