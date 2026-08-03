import {
  healMarkdown,
  neutralizeBroadcast,
  restoreAnnotatedMentions,
  type ThreadHandle as Thread,
} from '@/harness';
import { resolveIdentity } from '@/lib/identity';
import logger from '@/lib/logger';

// Slack rejects oversized messages (`msg_blocks_too_long`), so streamed prose is
// posted in pieces. We cut on blank-line boundaries; tables, lists and
// paragraphs never contain a blank line, so they stay intact; only fenced code
// can, which `openFence` guards. Each piece is healed through the SDK's
// `StreamingMarkdownRenderer` so a forced mid-paragraph cut still closes any
// dangling inline markers. See vercel/chat#408: once the Slack adapter owns
// length splitting, this whole module collapses into `thread.post(stream)`.
// Slack caps a section block's text near 3000 chars, so keep each post under it.
const MAX_POST = 2900;
const MIN_CHUNK = 280;
const SOFT_FLUSH = 900;
const IDLE_MS = 1500;
const FENCE_REOPEN_PADDING = 3;
const TABLE_SEPARATOR = /^\|?[\s:|-]*-{2,}[\s:|-]*$/;

export function createReply({
  allowBroadcast = false,
  threadId,
}: {
  // Only the owner may make kyto ping @channel/@here/@everyone; for everyone
  // else broadcast tokens are downgraded to inert plaintext before posting.
  allowBroadcast?: boolean;
  threadId: string;
}) {
  let buffer = '';
  let lastPostAt = Date.now();

  async function drain({
    force,
    thread,
  }: {
    force: boolean;
    thread: Thread;
  }): Promise<void> {
    while (buffer.trim()) {
      const index = nextCut(force);
      if (index === undefined) {
        return;
      }
      const chunk = take(index);
      if (!chunk) {
        continue;
      }
      // The normal identity profile can restyle kyto's avatar on ordinary
      // replies — icon only, the name stays plain "kyto". Cached 30s, and it
      // never throws (resolveIdentity swallows load errors).
      const { iconEmoji, iconUrl } = await resolveIdentity('normal');
      await thread
        // `post` denies broadcasts by default; the owner's streamed reply is
        // one of the two paths allowed to opt in (this thread IS the channel
        // kyto was invoked in). `take` has already neutralized the chunk when
        // allowBroadcast is false, so this is belt and braces either way.
        .post({ allowBroadcast, iconEmoji, iconUrl, markdown: chunk })
        .then(() => {
          lastPostAt = Date.now();
        })
        .catch((error: unknown) => {
          logger.warn({ err: error, threadId }, '[agent] reply post failed');
        });
    }
  }

  function nextCut(force: boolean): number | undefined {
    if (buffer.length > MAX_POST) {
      return hardCut(buffer.slice(0, MAX_POST));
    }
    if (
      !force &&
      buffer.length < SOFT_FLUSH &&
      Date.now() - lastPostAt < IDLE_MS
    ) {
      return;
    }
    return (
      boundaryCut(force ? 0 : MIN_CHUNK) ?? (force ? buffer.length : undefined)
    );
  }

  // Blank lines are the only split boundary: tables, lists, paragraphs and code
  // never contain one, so they stay intact. Anything with no blank line rides
  // along until the MAX_POST hard cut.
  function boundaryCut(threshold: number): number | undefined {
    const paragraph = buffer.lastIndexOf('\n\n') + 2;
    if (
      paragraph - 2 >= 0 &&
      paragraph >= threshold &&
      outsideFence(paragraph)
    ) {
      return paragraph;
    }
    return;
  }

  function outsideFence(index: number): boolean {
    return openFence(buffer.slice(0, index)) === null;
  }

  function take(index: number): string {
    const raw = buffer.slice(0, index);
    let rest = buffer.slice(index).replace(/^\n+/, '');
    const fence = openFence(raw);
    let chunk = raw;
    if (fence === null) {
      // A table cut between rows loses its header; repeat it so the remainder
      // still renders as a table instead of loose rows.
      const header = continuedTableHeader({ chunk: raw, remainder: rest });
      if (header) {
        rest = `${header}\n${rest}`;
      }
    } else {
      chunk = `${raw.replace(/\s+$/, '')}\n\`\`\``;
      rest = rest ? `\`\`\`${fence}\n${rest}` : '';
    }
    buffer = rest;
    // restoreAnnotatedMentions first: the model writes mentions in the
    // annotated form it was SHOWN (`@name (Uxxx)`), which Slack renders as inert
    // text. Turning it back into `<@Uxxx>` here is what makes a mention ping.
    // Broadcast neutralization still runs after, so this cannot smuggle one in
    // (it only ever produces `<@ID>`, never a `<!channel>` control token).
    const restored = restoreAnnotatedMentions(chunk);
    return heal(allowBroadcast ? restored : neutralizeBroadcast(restored));
  }

  return {
    append({ text, thread }: { text: string; thread: Thread }): Promise<void> {
      buffer += text;
      return drain({ force: false, thread });
    },
    // Throw away everything still buffered, i.e. everything not yet posted. Used
    // when an attempt degenerates into a token loop: the loop is caught within a
    // few short lines, which is well under the flush thresholds above, so this is
    // what actually keeps it out of the thread.
    drop(): void {
      buffer = '';
    },
    // Unbuffer just this trailing text, if it is still unposted. Used to retract
    // one attempt's output without touching an earlier attempt's — `drop()` would
    // throw away a previous model's real answer along with it. A no-op once the
    // text has already gone to Slack, which is the honest outcome: it cannot be
    // unsent, and silently reporting success would be worse.
    dropTail(text: string): boolean {
      if (!(text && buffer.endsWith(text))) {
        return false;
      }
      buffer = buffer.slice(0, -text.length);
      return true;
    },
    flush({ thread }: { thread: Thread }): Promise<void> {
      return drain({ force: true, thread });
    },
  };
}

function hardCut(text: string): number {
  const floor = Math.floor(text.length / FENCE_REOPEN_PADDING);
  const paragraph = text.lastIndexOf('\n\n');
  if (paragraph >= floor) {
    return paragraph + 2;
  }
  const line = text.lastIndexOf('\n');
  return line >= floor ? line + 1 : text.length;
}

function heal(markdown: string): string {
  return healMarkdown(markdown).trim();
}

function openFence(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    const match = /^\s*(?:```|~~~)(.*)$/.exec(line);
    if (match) {
      open = open === null ? (match[1] ?? '').trim() : null;
    }
  }
  return open;
}

// When a chunk ends inside a table and the remainder continues it, return that
// table's "header + separator" rows so they can be re-prepended to the remainder.
function continuedTableHeader({
  chunk,
  remainder,
}: {
  chunk: string;
  remainder: string;
}): string | null {
  const lines = chunk.replace(/\n+$/, '').split('\n');
  const lastLine = lines.at(-1) ?? '';
  const nextLine = remainder.split('\n')[0] ?? '';
  if (!(looksLikeTableRow(lastLine) && looksLikeTableRow(nextLine))) {
    return null;
  }
  let start = lines.length;
  while (start > 0 && looksLikeTableRow(lines[start - 1] ?? '')) {
    start -= 1;
  }
  const header = lines[start];
  const separator = lines[start + 1];
  if (!(header && separator && TABLE_SEPARATOR.test(separator.trim()))) {
    return null;
  }
  const reopened = `${header}\n${separator}`;
  return remainder.startsWith(reopened) ? null : reopened;
}

function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (TABLE_SEPARATOR.test(trimmed)) {
    return true;
  }
  return (
    trimmed.startsWith('|') || (trimmed.includes('|') && trimmed.endsWith('|'))
  );
}
