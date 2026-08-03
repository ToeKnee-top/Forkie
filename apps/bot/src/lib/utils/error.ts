export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return String(error);
}

// Depth cap: an error chain is short, and a malformed `cause` cycle must not
// hang whatever is inspecting it.
const UNWRAP_DEPTH = 4;

/**
 * SHAPE of a message content value — never its text. kyto reads private mail,
 * so a diagnostic must not spill content into the journal. Returns e.g.
 * `str(0)` (an EMPTY string body — a classic InvalidPrompt cause) or
 * `[text,tool-call:2,image]`.
 */
function describeContent(content: unknown): string {
  if (typeof content === 'string') {
    return `str(${content.length})`;
  }
  if (Array.isArray(content)) {
    if (content.length === 0) {
      return '[empty]';
    }
    return `[${content
      .map((part) => {
        const type =
          part && typeof part === 'object'
            ? String((part as Record<string, unknown>).type ?? '?')
            : typeof part;
        return type;
      })
      .join(',')}]`;
  }
  return content == null ? 'null' : typeof content;
}

/**
 * When the SDK refuses a prompt kyto built, the WHY is a specific message that
 * doesn't match the schema — an empty content string, a tool-call with no
 * matching tool-result, a bad role. The AI SDK carries the offending prompt on
 * the error (`.prompt`, or `.value` on a conversion error). Summarize each
 * message as `role:shape`, content SHAPE only, so the journal shows which one is
 * wrong without leaking any private message text.
 */
export function describeMalformedPrompt(error: unknown): string | undefined {
  for (
    let cursor: unknown = error, depth = 0;
    cursor && typeof cursor === 'object' && depth <= UNWRAP_DEPTH;
    depth += 1
  ) {
    const record = cursor as Record<string, unknown>;
    const candidate = record.prompt ?? record.messages ?? record.value;
    if (Array.isArray(candidate)) {
      return candidate
        .map((message) => {
          const rec =
            message && typeof message === 'object'
              ? (message as Record<string, unknown>)
              : {};
          const role = String(rec.role ?? '?');
          return `${role}:${describeContent(rec.content)}`;
        })
        .join(' | ');
    }
    cursor = record.cause;
  }
  return;
}
const BODY_KEYS = ['responseBody', 'data', 'statusCode'] as const;
const WRAPPER_KEYS = ['lastError', 'cause'] as const;

/**
 * Every scrap of text in an error chain: its message, any HTTP response body,
 * and the same for whatever it wraps.
 *
 * The unwrapping matters. The AI SDK retries internally and rethrows an
 * `AI_RetryError` whose own message is just "Failed after 3 attempts…", while
 * the upstream body that says *why* (e.g. HackClub's "Key limit exceeded (daily
 * limit)") hangs off `lastError`/`errors`. Matching a provider's failure mode
 * on the outer message alone silently misses it.
 */
export function deepErrorText(error: unknown, depth = 0): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error == null || depth > UNWRAP_DEPTH) {
    return '';
  }
  const pieces: string[] = [];
  if (error instanceof Error) {
    pieces.push(error.message);
  }
  const record = error as Record<string, unknown>;
  for (const key of BODY_KEYS) {
    const value = record[key];
    if (value != null) {
      pieces.push(typeof value === 'string' ? value : JSON.stringify(value));
    }
  }
  for (const key of WRAPPER_KEYS) {
    if (record[key] != null) {
      pieces.push(deepErrorText(record[key], depth + 1));
    }
  }
  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) {
      pieces.push(deepErrorText(nested, depth + 1));
    }
  }
  return pieces.filter(Boolean).join(' ') || String(error);
}

/**
 * The HTTP status buried in a provider error chain, if any. The AI SDK wraps the
 * real `APICallError` (which carries `statusCode`) inside an `AI_RetryError`, so
 * the status a log needs to say "429, rate limited" is never on the outer error.
 */
export function errorStatus(error: unknown, depth = 0): number | undefined {
  if (error == null || depth > UNWRAP_DEPTH) {
    return;
  }
  const record = error as Record<string, unknown>;
  if (typeof record.statusCode === 'number') {
    return record.statusCode;
  }
  for (const key of WRAPPER_KEYS) {
    const status = errorStatus(record[key], depth + 1);
    if (status !== undefined) {
      return status;
    }
  }
  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) {
      const status = errorStatus(nested, depth + 1);
      if (status !== undefined) {
        return status;
      }
    }
  }
  return;
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(errorMessage(error), { cause: error });
}

export function toLogError(error: unknown): { err: Error } {
  return { err: toError(error) };
}
