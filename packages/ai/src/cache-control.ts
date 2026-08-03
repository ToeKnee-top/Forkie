// Prompt-cache breakpoint placement — the pure decision half of prompt caching,
// in its own module so it can be tested without booting the provider/env layer
// (see agent.cache.test.ts). agent.ts calls addCacheControl once per outgoing
// request from its fetch wrapper.

// A 1-hour cache breakpoint. Anthropic (and OpenRouter's passthrough to it)
// accept `ttl: '1h'` to extend the default 5-minute ephemeral cache to an hour,
// so the big system+tools prefix stays cached across a thread's sporadic turns
// (not just within one multi-step loop). Providers without extended TTL ignore
// the field; a bare `{ type: 'ephemeral' }` would just fall back to 5 minutes.
const CACHE_CONTROL = { ttl: '1h', type: 'ephemeral' } as const;

// Attach the cache breakpoint to a message's last content block, converting a
// string body to the content-array form OpenRouter expects. Returns false (a
// no-op) when there is nothing to attach to — an empty string or empty content
// array — so a caller can fall back to the next message.
function markCacheBreakpoint(message: Record<string, unknown>): boolean {
  const content = message.content;
  if (typeof content === 'string') {
    if (content.length === 0) {
      return false;
    }
    message.content = [
      { cache_control: CACHE_CONTROL, text: content, type: 'text' },
    ];
    return true;
  }
  if (Array.isArray(content) && content.length > 0) {
    const last = content.at(-1);
    if (last && typeof last === 'object') {
      (last as Record<string, unknown>).cache_control = CACHE_CONTROL;
      return true;
    }
  }
  return false;
}

// Two breakpoints:
//
//  A — the last SYSTEM message: caches the big constant prefix (system prompt +
//      tool schemas).
//  B — the last MESSAGE, whatever its role: caches everything sent so far,
//      including the growing assistant-tool-call / tool-result tail.
//
// B used to be pinned to the last USER message, and that was the bug behind
// "the whole prompt re-bills every step". A multi-step tool loop appends only
// assistant/tool messages after the single opening user message — there is never
// a new user message to advance the breakpoint to, so from step ~3 the entire
// accumulated tool tail sat AFTER the breakpoint and was re-billed uncached on
// every step, growing each time. Marking the literal last message instead (the
// AI SDK's own addCacheControlToMessages pattern) moves the breakpoint forward
// each step, so only the newest tool output is uncached. Providers without
// explicit caching ignore the field. Anthropic allows 4 breakpoints; two is safe.
export function addCacheControl(payload: Record<string, unknown>): boolean {
  const messages = payload.messages;
  if (!Array.isArray(messages)) {
    return false;
  }
  const reversed = [...messages].reverse() as Record<string, unknown>[];
  let changed = false;
  const lastSystem = reversed.find((m) => m.role === 'system');
  if (lastSystem && markCacheBreakpoint(lastSystem)) {
    changed = true;
  }
  // Breakpoint B: walk from the newest message toward the front and mark the
  // first one a breakpoint can actually attach to. A pure tool-call assistant
  // message (content null, args in tool_calls) has no content block, so
  // markCacheBreakpoint no-ops on it — skip to the message before it. Stop at
  // the system message (it already carries breakpoint A).
  for (const message of reversed) {
    if (message === lastSystem) {
      break;
    }
    if (markCacheBreakpoint(message)) {
      changed = true;
      break;
    }
  }
  return changed;
}
