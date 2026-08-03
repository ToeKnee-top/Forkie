import { describe, expect, test } from 'bun:test';
import { addCacheControl } from './cache-control';

// The cache_control shape addCacheControl attaches (1h ephemeral breakpoint).
interface Block {
  cache_control?: unknown;
  text?: string;
  type?: string;
}
interface Message {
  content: unknown;
  role: string;
}

function cached(message: Message): boolean {
  const content = message.content;
  if (!Array.isArray(content)) {
    return false;
  }
  const last = content.at(-1) as Block | undefined;
  return Boolean(last?.cache_control);
}

// A realistic multi-step tool loop: system, the single opening user message,
// then the assistant-tool-call / tool-result pairs that accrue each step.
function toolLoopPayload(steps: number) {
  const messages: Message[] = [
    { content: 'system + tools', role: 'system' },
    { content: 'do the thing', role: 'user' },
  ];
  for (let i = 0; i < steps; i += 1) {
    messages.push({ content: [{ type: 'tool-call' }], role: 'assistant' });
    messages.push({ content: `result ${i}`, role: 'tool' });
  }
  return { messages };
}

describe('addCacheControl', () => {
  test('marks the last system message', () => {
    const payload = toolLoopPayload(0);
    addCacheControl(payload);
    expect(cached(payload.messages[0] as Message)).toBe(true);
  });

  test('breakpoint B lands on the LAST message, not the opening user message', () => {
    // The regression that re-billed the whole tail: with the tail present, the
    // breakpoint must be on the final tool result, NOT the user message.
    const payload = toolLoopPayload(3);
    addCacheControl(payload);
    const messages = payload.messages as Message[];
    const user = messages.find((m) => m.role === 'user');
    const lastTool = messages.at(-1) as Message;
    expect(cached(lastTool)).toBe(true);
    // The user message keeps a plain string body — it is NOT the breakpoint.
    expect(cached(user as Message)).toBe(false);
  });

  test('the breakpoint advances as the tail grows', () => {
    // Each step, the breakpoint should be on the newest message so only the
    // latest output is uncached.
    const shallow = toolLoopPayload(1);
    addCacheControl(shallow);
    expect(cached(shallow.messages.at(-1) as Message)).toBe(true);

    const deep = toolLoopPayload(6);
    addCacheControl(deep);
    expect(cached(deep.messages.at(-1) as Message)).toBe(true);
  });

  test('skips a trailing pure tool-call message with no attachable content', () => {
    // A pure tool-call assistant message (array content, but the block carries
    // no text to attach to — still fine here) vs. genuinely empty content.
    const payload = {
      messages: [
        { content: 'system', role: 'system' },
        { content: 'go', role: 'user' },
        { content: 'earlier answer', role: 'assistant' },
        // Trailing message with EMPTY content array — nothing to mark.
        { content: [], role: 'assistant' },
      ] as Message[],
    };
    addCacheControl(payload);
    // Falls back to the nearest markable message (the assistant text).
    expect(cached(payload.messages[2] as Message)).toBe(true);
  });

  test('no messages: no throw, no change', () => {
    expect(addCacheControl({})).toBe(false);
  });
});
