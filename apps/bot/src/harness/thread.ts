import {
  deleteThreadSubscription,
  getThreadSubscription,
  setThreadFocus,
  setThreadSubscription,
} from '@repo/db/queries';
import type { Logger } from '@repo/logging/logger';
import type { SlackHarness } from './harness';
import { neutralizeBroadcast, neutralizeBroadcastDeep } from './markdown';
import type {
  Author,
  ChannelMetadata,
  PostContent,
  SentMessage,
  ThreadState,
} from './types';

// Slack's markdown block caps text at 12k; our reply chunker posts well under
// this, but clamp defensively so an oversized post degrades instead of erroring.
const MARKDOWN_BLOCK_MAX = 11_800;

// Slack's newer `markdown` block renders user (`<@U…>`) and channel (`<#C…>`)
// links, but NOT broadcast/control mentions — `<!channel>`, `<!here>`,
// `<!everyone>`, or user-group `<!subteam^…>` all come out as plaintext there.
// Only the legacy `mrkdwn` text object resolves them into real pings. So when a
// message contains one, we render it as a `section`+`mrkdwn` block instead of a
// `markdown` block (broadcast announcements are simple text, so losing GFM
// niceties for them is an acceptable trade for the mention actually working).
const CONTROL_MENTION =
  /<!(?:channel|here|everyone)(?:\|[^>]*)?>|<!subteam\^[^>]+>/;

function hasControlMention(text: string | undefined): boolean {
  return text !== undefined && CONTROL_MENTION.test(text);
}

/**
 * Neutralize broadcast tokens in every part of a post that Slack reads as text.
 *
 * Field-by-field rather than a blanket deep walk: `files[].data` is binary, and
 * `neutralizeBroadcastDeep` would happily turn a Uint8Array into a plain object
 * on its way through. Blocks DO get the deep walk — a token smuggled into a
 * block's text notifies exactly like message text.
 */
function stripBroadcasts(post: PostContent): PostContent {
  return {
    ...post,
    ...(post.blocks
      ? { blocks: neutralizeBroadcastDeep(post.blocks) as unknown[] }
      : {}),
    ...(post.fallbackText
      ? { fallbackText: neutralizeBroadcast(post.fallbackText) }
      : {}),
    ...(post.markdown ? { markdown: neutralizeBroadcast(post.markdown) } : {}),
  };
}

// Short-lived cache so chatty channels don't hit Postgres for every message
// when deciding whether a thread is subscribed.
const SUBSCRIPTION_CACHE_TTL_MS = 30_000;
const subscriptionCache = new Map<
  string,
  { at: number; state: ThreadState | null }
>();

function cacheSubscription(threadId: string, state: ThreadState | null): void {
  subscriptionCache.set(threadId, { at: Date.now(), state });
}

/**
 * A channel/thread handle: `slack:CHANNEL:THREAD_TS` (in-thread posts) or
 * `slack:CHANNEL` (top-level posts). Mirrors the old chat-sdk Thread surface.
 */
export class ThreadHandle {
  readonly id: string;
  /** The harness, exposed for tools that need raw adapter access. */
  readonly adapter: SlackHarness;
  private readonly logger: Logger;

  constructor({
    harness,
    id,
    logger,
  }: {
    harness: SlackHarness;
    id: string;
    logger: Logger;
  }) {
    this.adapter = harness;
    this.id = id;
    this.logger = logger;
  }

  private get location(): { channel: string; threadTs: string } {
    return this.adapter.decodeThreadId(this.id);
  }

  async post(content: PostContent | string): Promise<SentMessage> {
    const { channel, threadTs } = this.location;
    const raw: PostContent =
      typeof content === 'string' ? { markdown: content } : content;
    // Broadcast pings are DENIED BY DEFAULT, here, at the one place every post
    // goes through. Callers that are genuinely allowed to notify a channel (the
    // owner's streamed reply, an owner's same-channel postMessage) opt in.
    //
    // It used to be the other way round — each caller remembered to call
    // neutralizeBroadcast — and the ones that forgot were exactly the paths
    // nobody thinks of as "the model talking": a REMINDER (its text, and an
    // agent reminder's entire generated body, are model-authored and reminders
    // can be created by anyone), and the `title` on a mermaid diagram or an
    // uploadFile. `post` renders a control mention as a section+mrkdwn block
    // specifically so it resolves into a real ping, so those paths notified
    // the whole channel with nothing in front of them.
    const post = raw.allowBroadcast ? raw : stripBroadcasts(raw);

    if (post.files?.length) {
      return await this.postFiles({ channel, post, threadTs });
    }

    const markdown = post.markdown?.slice(0, MARKDOWN_BLOCK_MAX);
    const blocks =
      post.blocks ??
      (markdown
        ? [
            hasControlMention(markdown)
              ? { text: { text: markdown, type: 'mrkdwn' }, type: 'section' }
              : { text: markdown, type: 'markdown' },
          ]
        : undefined);
    const args = {
      ...(blocks ? { blocks } : {}),
      channel,
      ...(post.iconEmoji ? { icon_emoji: post.iconEmoji } : {}),
      ...(post.iconUrl ? { icon_url: post.iconUrl } : {}),
      ...(post.metadata ? { metadata: post.metadata } : {}),
      text: post.fallbackText ?? post.markdown ?? '',
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(post.username ? { username: post.username } : {}),
    };
    // Cast: ChatPostMessageArguments is a strict discriminated union that
    // rejects this options-spread shape even when the payload is valid.
    const result = await this.adapter.webClient.chat.postMessage(args as never);
    return this.sent(result.ts ?? '', result);
  }

  private async postFiles({
    channel,
    post,
    threadTs,
  }: {
    channel: string;
    post: PostContent;
    threadTs: string;
  }): Promise<SentMessage> {
    const uploads = post.files ?? [];
    const result = await this.adapter.webClient.filesUploadV2({
      channel_id: channel,
      file_uploads: uploads.map((file) => ({
        file: Buffer.from(file.data),
        filename: file.filename,
      })),
      ...(post.markdown ? { initial_comment: post.markdown } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return this.sent('', result);
  }

  private sent(ts: string, raw: unknown): SentMessage {
    const { channel } = this.location;
    return {
      delete: async () => {
        if (!ts) {
          return;
        }
        await this.adapter.webClient.chat.delete({ channel, ts });
      },
      id: ts,
      raw,
      threadId: this.id,
    };
  }

  /**
   * Show a message only `user` can see.
   *
   * Returns where it actually landed. That matters for anything that later
   * wants to REPLACE what it posted: an ephemeral is edited through the
   * interaction's `response_url` with `replace_original`, but the DM fallback
   * is an ordinary message, where `replace_original` does nothing and the
   * update lands as a SECOND message — leaving the original sitting there with
   * its buttons still live. Callers that update themselves need to know which
   * one they got.
   */
  async postEphemeral(
    user: Author | string,
    text: string,
    options: { fallbackToDM?: boolean; blocks?: unknown[] } = {}
  ): Promise<{ channel?: string; delivery: 'ephemeral' | 'dm'; ts?: string }> {
    const userId = typeof user === 'string' ? user : user.userId;
    const { channel, threadTs } = this.location;
    const blocks = options.blocks;
    try {
      await this.adapter.webClient.chat.postEphemeral({
        channel,
        text,
        ...(blocks ? { blocks } : {}),
        ...(threadTs ? { thread_ts: threadTs } : {}),
        user: userId,
      } as Parameters<typeof this.adapter.webClient.chat.postEphemeral>[0]);
      return { delivery: 'ephemeral' };
    } catch (error) {
      if (!options.fallbackToDM) {
        throw error;
      }
      const dm = await this.adapter.webClient.conversations.open({
        users: userId,
      });
      const dmChannel = dm.channel?.id;
      if (!dmChannel) {
        throw error;
      }
      const sent = await this.adapter.webClient.chat.postMessage({
        channel: dmChannel,
        ...(blocks ? { blocks } : {}),
        text,
      });
      return { channel: dmChannel, delivery: 'dm', ts: sent.ts };
    }
  }

  // ── Subscription state (respondOnThreadMessages) ────────────────────────

  get state(): Promise<ThreadState | null> {
    return this.readState();
  }

  private async readState(): Promise<ThreadState | null> {
    const cached = subscriptionCache.get(this.id);
    if (cached && Date.now() - cached.at < SUBSCRIPTION_CACHE_TTL_MS) {
      return cached.state;
    }
    const row = await getThreadSubscription(this.id).catch((error: unknown) => {
      this.logger.warn(
        { err: error, threadId: this.id },
        '[harness] thread state read failed'
      );
      return null;
    });
    const state = row
      ? {
          focusUserIds: row.focusUserIds ?? null,
          respondOnThreadMessages: row.respondOnThreadMessages,
        }
      : null;
    cacheSubscription(this.id, state);
    return state;
  }

  /** Set (or clear, with null) which users kyto responds to in this thread. */
  async setFocus(focusUserIds: string[] | null): Promise<void> {
    await setThreadFocus(this.id, focusUserIds);
    subscriptionCache.delete(this.id);
  }

  async setState(state: ThreadState): Promise<void> {
    await setThreadSubscription(
      this.id,
      state.respondOnThreadMessages === true
    );
    cacheSubscription(this.id, state);
  }

  async subscribe(): Promise<void> {
    // Subscribing without an explicit state means "follow this thread".
    const current = await this.readState();
    await this.setState({
      respondOnThreadMessages: current?.respondOnThreadMessages ?? true,
    });
  }

  async unsubscribe(): Promise<void> {
    await deleteThreadSubscription(this.id).catch((error: unknown) => {
      this.logger.warn(
        { err: error, threadId: this.id },
        '[harness] unsubscribe failed'
      );
    });
    cacheSubscription(this.id, null);
  }

  /** Best-effort "working on it" indicator for non-assistant surfaces. */
  startTyping(_status?: string): Promise<void> {
    return Promise.resolve();
  }

  /** Schedule a one-time message via Slack's native chat.scheduleMessage. */
  async schedule(
    content: PostContent | string,
    { postAt }: { postAt: Date }
  ): Promise<void> {
    const { channel, threadTs } = this.location;
    const post: PostContent =
      typeof content === 'string' ? { markdown: content } : content;
    const markdown = post.markdown?.slice(0, MARKDOWN_BLOCK_MAX);
    await this.adapter.webClient.chat.scheduleMessage({
      ...(markdown
        ? { blocks: [{ text: markdown, type: 'markdown' }] as never }
        : {}),
      channel,
      post_at: Math.floor(postAt.getTime() / 1000),
      text: post.fallbackText ?? post.markdown ?? '',
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  async fetchMetadata(): Promise<ChannelMetadata> {
    const { channel } = this.location;
    const info = await this.adapter.webClient.conversations.info({ channel });
    const conversation = info.channel;
    const isDM = conversation?.is_im === true || conversation?.is_mpim === true;
    let channelVisibility: ChannelMetadata['channelVisibility'] = 'workspace';
    if (conversation?.is_ext_shared || conversation?.is_pending_ext_shared) {
      channelVisibility = 'external';
    } else if (isDM || conversation?.is_private) {
      channelVisibility = 'private';
    }
    return {
      channelVisibility,
      id: channel,
      isDM,
      memberCount: (conversation as { num_members?: number } | undefined)
        ?.num_members,
      name: conversation?.name,
    };
  }
}
