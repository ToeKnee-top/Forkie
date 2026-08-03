import type { Logger } from '@repo/logging/logger';
import { WebClient } from '@slack/web-api';
import { mrkdwnToMarkdown } from './markdown';
import type { Author, Message, MessageAttachment, StreamChunk } from './types';

// Raw Slack message event fields the harness reads.
export interface RawSlackMessage {
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  files?: RawSlackFile[];
  subtype?: string;
  team?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  user?: string;
  [key: string]: unknown;
}

interface RawSlackFile {
  id?: string;
  mimetype?: string;
  name?: string;
  url_private?: string;
}

const USER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// Slack keeps a single native stream (chat.startStream → appendStream) open only
// ~5 minutes; past that the stream expires and further appends are dropped. A
// turn that runs a long stretch of tools would otherwise have its live plan card
// die mid-render. So we proactively rotate to a FRESH streamer (a new plan
// message) a little before the limit — a new card is exactly the desired outcome
// here. Task cards from the old stream are finalized as-is when it stops.
const STREAM_ROTATE_MS = 4.5 * 60 * 1000;

// Recursively pull readable text out of a Slack rich-text node (table cells are
// rich_text blocks). Collects `text`, link labels/urls, and recurses into
// `elements`. Kept tolerant of unknown shapes since the payload is untyped.
function richTextPlain(node: unknown): string {
  if (typeof node === 'string') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(richTextPlain).join('');
  }
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.elements)) {
      return record.elements.map(richTextPlain).join('');
    }
    if (typeof record.text === 'string') {
      return record.text;
    }
    if (typeof record.url === 'string') {
      return record.url;
    }
  }
  return '';
}

// Gather every block from a message: top-level `blocks` PLUS each attachment's
// `blocks`. A pasted table arrives as a `table` block inside `attachments[]`,
// not in the top-level `blocks`, so both must be scanned.
function collectBlocks(event: RawSlackMessage): unknown[] {
  const blocks: unknown[] = Array.isArray(event.blocks)
    ? [...event.blocks]
    : [];
  const attachments = (event as { attachments?: unknown }).attachments;
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      const nested = (attachment as { blocks?: unknown } | null)?.blocks;
      if (Array.isArray(nested)) {
        blocks.push(...nested);
      }
    }
  }
  return blocks;
}

// Render any Slack `table` blocks in a message as markdown tables. Table content
// lives only in these blocks (never in `event.text`), so without this kyto is
// blind to pasted/posted tables.
function extractTables(event: RawSlackMessage): string | undefined {
  const blocks = collectBlocks(event);
  if (blocks.length === 0) {
    return;
  }
  const tables: string[] = [];
  for (const block of blocks) {
    const record = block as Record<string, unknown> | null;
    if (!(record && record.type === 'table' && Array.isArray(record.rows))) {
      continue;
    }
    const rows = record.rows
      .map((row) => {
        const cells = Array.isArray(row) ? row : [];
        return `| ${cells.map((cell) => richTextPlain(cell).replace(/\s+/g, ' ').trim() || ' ').join(' | ')} |`;
      })
      .filter((line) => line.replace(/[|\s]/g, '').length > 0);
    if (rows.length === 0) {
      continue;
    }
    // Insert a markdown header separator after the first row so it renders as a
    // real table (Slack tables treat the first row as the header).
    const columnCount = (rows[0]?.match(/\|/g)?.length ?? 2) - 1;
    const separator = `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`;
    tables.push([rows[0], separator, ...rows.slice(1)].join('\n'));
  }
  return tables.length > 0 ? tables.join('\n\n') : undefined;
}

/**
 * Thin, fully-owned Slack Web API facade: thread id codec, message
 * construction, posting/fetching, reactions, assistant status, and native
 * streaming. Replaces @chat-adapter/slack.
 */
export class SlackHarness {
  readonly webClient: WebClient;
  botUserId: string | undefined;
  teamId: string | undefined;
  private readonly logger: Logger;
  private readonly userCache = new Map<
    string,
    { at: number; author: Author }
  >();

  constructor({ botToken, logger }: { botToken: string; logger: Logger }) {
    this.webClient = new WebClient(botToken);
    this.logger = logger;
  }

  async connectIdentity(): Promise<void> {
    const auth = await this.webClient.auth.test();
    this.botUserId = auth.user_id ?? undefined;
    this.teamId = auth.team_id ?? undefined;
  }

  // ── Thread ids ──────────────────────────────────────────────────────────

  encodeThreadId({
    channel,
    threadTs,
  }: {
    channel: string;
    threadTs: string;
  }): string {
    return threadTs ? `slack:${channel}:${threadTs}` : `slack:${channel}`;
  }

  decodeThreadId(threadId: string): { channel: string; threadTs: string } {
    const [, channel = '', threadTs = ''] = threadId.split(':');
    return { channel, threadTs };
  }

  channelIdFromThreadId(threadId: string): string {
    return `slack:${this.decodeThreadId(threadId).channel}`;
  }

  isDM(threadId: string): boolean {
    return this.decodeThreadId(threadId).channel.startsWith('D');
  }

  // ── Messages ────────────────────────────────────────────────────────────

  buildMessage(event: RawSlackMessage, author: Author): Message {
    const channel = event.channel ?? '';
    const ts = event.ts ?? '';
    // Every message threads: a top-level message roots its own thread (this is
    // the DM-threading behavior the old adapter needed a patch for).
    const threadTs = event.thread_ts || ts;
    const text = event.text ?? '';
    // Slack renders tables (and some rich content) as `table` blocks whose text
    // is NOT in `event.text`, so the model would otherwise be blind to them.
    // Extract any table blocks into markdown and append so kyto can read them.
    const tables = extractTables(event);
    const body = tables
      ? `${mrkdwnToMarkdown(text)}\n\n${tables}`.trim()
      : mrkdwnToMarkdown(text);
    return {
      attachments: this.buildAttachments(event.files ?? []),
      author,
      id: ts,
      isMention: this.botUserId ? text.includes(`<@${this.botUserId}>`) : false,
      metadata: {
        dateSent: ts ? new Date(Number.parseFloat(ts) * 1000) : undefined,
        edited: Boolean(event.edited),
      },
      raw: event as Record<string, unknown>,
      text: body,
      threadId: this.encodeThreadId({ channel, threadTs }),
    };
  }

  private buildAttachments(files: RawSlackFile[]): MessageAttachment[] {
    return files.flatMap((file) => {
      const url = file.url_private;
      if (!url) {
        return [];
      }
      return [
        {
          fetchData: () => this.downloadFile(url),
          mimeType: file.mimetype,
          name: file.name,
          type: file.mimetype?.startsWith('image/') ? 'image' : 'file',
          url,
        },
      ];
    });
  }

  private async downloadFile(url: string): Promise<Uint8Array | null> {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.webClient.token ?? ''}` },
      });
      if (!response.ok) {
        return null;
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      this.logger.warn({ err: error, url }, '[harness] file download failed');
      return null;
    }
  }

  async getUser(userId: string): Promise<Author> {
    const cached = this.userCache.get(userId);
    if (cached && Date.now() - cached.at < USER_CACHE_TTL_MS) {
      return cached.author;
    }
    let author: Author = { userId, userName: userId };
    try {
      const { user } = await this.webClient.users.info({ user: userId });
      author = {
        fullName: user?.profile?.real_name || user?.real_name || undefined,
        isBot: user?.is_bot,
        isMe: userId === this.botUserId,
        userId,
        userName:
          user?.profile?.display_name ||
          user?.name ||
          user?.real_name ||
          userId,
      };
    } catch (error) {
      this.logger.warn({ err: error, userId }, '[harness] users.info failed');
    }
    this.userCache.set(userId, { at: Date.now(), author });
    return author;
  }

  /**
   * Thread history, oldest first within the returned slice. The default
   * `backward` direction keeps the NEWEST `limit` messages (following cursors
   * to the end of the thread, bounded); `forward` returns the first page.
   */
  async fetchMessages(
    threadId: string,
    {
      cursor,
      direction = 'backward',
      limit = 100,
    }: {
      cursor?: string;
      direction?: 'backward' | 'forward';
      limit?: number;
    } = {}
  ): Promise<{ messages: Message[]; nextCursor?: string }> {
    const { channel, threadTs } = this.decodeThreadId(threadId);
    if (!threadTs) {
      return { messages: [] };
    }
    const maxPages = direction === 'backward' ? 10 : 1;
    let raw: RawSlackMessage[] = [];
    let nextCursor = cursor;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.webClient.conversations.replies({
        channel,
        ...(nextCursor ? { cursor: nextCursor } : {}),
        limit,
        ts: threadTs,
      });
      raw = raw.concat((result.messages ?? []) as RawSlackMessage[]);
      nextCursor = result.response_metadata?.next_cursor || undefined;
      if (!nextCursor) {
        break;
      }
    }
    if (direction === 'backward') {
      raw = raw.slice(-limit);
    }
    return {
      messages: await this.hydrateMessages(raw, channel),
      nextCursor,
    };
  }

  /** Top-level channel history, newest first (Slack's native order). */
  async fetchChannelMessages(
    channelId: string,
    { cursor, limit = 100 }: { cursor?: string; limit?: number } = {}
  ): Promise<{ messages: Message[]; nextCursor?: string }> {
    const channel = channelId.startsWith('slack:')
      ? (channelId.split(':')[1] ?? channelId)
      : channelId;
    const result = await this.webClient.conversations.history({
      channel,
      ...(cursor ? { cursor } : {}),
      limit,
    });
    return {
      messages: await this.hydrateMessages(
        (result.messages ?? []) as RawSlackMessage[],
        channel
      ),
      nextCursor: result.response_metadata?.next_cursor || undefined,
    };
  }

  /** Recent threads in a channel (history entries that have replies). */
  async listThreads(
    channelId: string,
    { cursor, limit = 20 }: { cursor?: string; limit?: number } = {}
  ): Promise<{
    nextCursor?: string;
    threads: {
      id: string;
      lastReplyAt?: Date;
      replyCount: number;
      rootMessage: Message;
    }[];
  }> {
    const channel = channelId.startsWith('slack:')
      ? (channelId.split(':')[1] ?? channelId)
      : channelId;
    const result = await this.webClient.conversations.history({
      channel,
      ...(cursor ? { cursor } : {}),
      limit,
    });
    const raw = ((result.messages ?? []) as RawSlackMessage[]).filter(
      (entry) => Number((entry as { reply_count?: number }).reply_count) > 0
    );
    const roots = await this.hydrateMessages(raw, channel);
    return {
      nextCursor: result.response_metadata?.next_cursor || undefined,
      threads: roots.map((rootMessage, index) => {
        const entry = raw[index] as {
          latest_reply?: string;
          reply_count?: number;
        };
        return {
          id: rootMessage.threadId,
          lastReplyAt: entry?.latest_reply
            ? new Date(Number.parseFloat(entry.latest_reply) * 1000)
            : undefined,
          replyCount: Number(entry?.reply_count ?? 0),
          rootMessage,
        };
      }),
    };
  }

  private async hydrateMessages(
    rawMessages: RawSlackMessage[],
    channel: string
  ): Promise<Message[]> {
    return await Promise.all(
      rawMessages
        .filter((raw) => raw.ts)
        .map(async (raw) => {
          const author = raw.user
            ? await this.getUser(raw.user)
            : {
                isBot: true,
                userId: raw.bot_id ?? 'bot',
                userName: raw.bot_id ?? 'bot',
              };
          return this.buildMessage({ ...raw, channel }, author);
        })
    );
  }

  addReaction(
    threadId: string,
    messageId: string,
    name: string
  ): Promise<unknown> {
    const { channel } = this.decodeThreadId(threadId);
    return this.webClient.reactions.add({
      channel,
      name,
      timestamp: messageId,
    });
  }

  removeReaction(
    threadId: string,
    messageId: string,
    name: string
  ): Promise<unknown> {
    const { channel } = this.decodeThreadId(threadId);
    return this.webClient.reactions.remove({
      channel,
      name,
      timestamp: messageId,
    });
  }

  // ── Assistant surface ───────────────────────────────────────────────────

  async setAssistantStatus(
    channelId: string,
    threadTs: string,
    status: string,
    loadingMessages?: string[]
  ): Promise<void> {
    await this.webClient.assistant.threads.setStatus({
      channel_id: channelId,
      ...(loadingMessages ? { loading_messages: loadingMessages } : {}),
      status,
      thread_ts: threadTs,
    });
  }

  async setSuggestedPrompts(
    channelId: string,
    threadTs: string,
    prompts: { message: string; title: string }[]
  ): Promise<void> {
    await this.webClient.assistant.threads.setSuggestedPrompts({
      channel_id: channelId,
      prompts: prompts as [{ message: string; title: string }],
      thread_ts: threadTs,
    });
  }

  // ── Native streaming (task cards) ───────────────────────────────────────

  /**
   * Stream chunks to Slack's native streaming API. Strings and markdown_text
   * chunks append as streamed text; task_update chunks render as native task
   * cards. Falls back to text-only if structured chunks are rejected.
   */
  async stream(
    threadId: string,
    chunks: AsyncIterable<string | StreamChunk>,
    options: {
      recipientTeamId: string;
      recipientUserId: string;
      taskDisplayMode?: 'plan';
      // Per-message identity override (needs chat:write.customize). Used so a
      // subagent's own streamed message posts as "kyto subagent" + its icon.
      username?: string;
      iconEmoji?: string;
      iconUrl?: string;
    }
  ): Promise<void> {
    const { channel, threadTs } = this.decodeThreadId(threadId);
    if (!threadTs) {
      throw new Error('Slack streaming requires a thread ts.');
    }
    const startStreamer = () =>
      this.webClient.chatStream({
        channel,
        recipient_team_id: options.recipientTeamId,
        recipient_user_id: options.recipientUserId,
        ...(options.taskDisplayMode
          ? { task_display_mode: options.taskDisplayMode }
          : {}),
        ...(options.username ? { username: options.username } : {}),
        ...(options.iconEmoji ? { icon_emoji: options.iconEmoji } : {}),
        ...(options.iconUrl ? { icon_url: options.iconUrl } : {}),
        thread_ts: threadTs,
      });
    let streamer = startStreamer();
    let streamStartedAt = Date.now();
    // Whether the CURRENT streamer has appended anything: decides whether to stop
    // it (both on rotation and at the end). Reset on each rotation.
    let currentHasContent = false;
    let structuredSupported = true;
    const stopStreamer = async (): Promise<void> => {
      if (!currentHasContent) {
        return;
      }
      await streamer.stop().catch((error: unknown) => {
        this.logger.warn({ err: error }, '[harness] stream stop failed');
      });
    };
    // Rotate to a fresh streamer before Slack expires the current one (see
    // STREAM_ROTATE_MS). Finalizes the current card and opens a new one that
    // subsequent chunks append to.
    const rotateIfStale = async (): Promise<void> => {
      if (Date.now() - streamStartedAt < STREAM_ROTATE_MS) {
        return;
      }
      await stopStreamer();
      streamer = startStreamer();
      streamStartedAt = Date.now();
      currentHasContent = false;
    };
    try {
      for await (const chunk of chunks) {
        await rotateIfStale();
        if (typeof chunk === 'string' || chunk.type === 'markdown_text') {
          const text = typeof chunk === 'string' ? chunk : chunk.text;
          if (text) {
            await streamer.append({ markdown_text: text });
            currentHasContent = true;
          }
          continue;
        }
        if (!structuredSupported) {
          continue;
        }
        try {
          await streamer.append({
            chunks: [chunk] as never,
          });
          currentHasContent = true;
        } catch (error) {
          structuredSupported = false;
          this.logger.warn(
            { err: error },
            '[harness] structured stream chunk rejected; text-only fallback'
          );
        }
      }
    } finally {
      await stopStreamer();
    }
  }
}
