import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  hasToolCall,
  type ModelMessage,
  stepCountIs,
  streamText,
  type ToolCallRepairFunction,
  type ToolSet,
} from 'ai';
import { addCacheControl } from './cache-control';
import { fetchWithGatewayRetry, type GatewayRetryInfo } from './gateway-retry';
import {
  GEMINI_PROVIDER,
  HACKCLUB_PROVIDER,
  MAX_OUTPUT_TOKENS,
  type ModelAttempt,
} from './providers/attempts';
import { CHATGPT_PROVIDER } from './providers/chatgpt';

// Ceiling on agentic steps within one attempt (model → tools → model …).
// Effectively "no limit" for real work: a hard 60 used to strand long jobs
// (screenshotting 50 captcha frames, a big scripted scrape) mid-solve, and the
// stop looked like "kyto went quiet in the middle". The real bound on a runaway
// attempt is the wall-clock watchdog (AGENT_ATTEMPT_TIMEOUT_MS) plus the
// degenerate-loop guard, not this counter — so it's set high and overridable.
export const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS) || 1000;

/**
 * The tool that means "this turn is over, say nothing". Its RESULT used to just
 * feed back into the loop like any other, so a model that decided not to answer
 * kept getting asked what to do next: observed as 5+ Thinking→`skip`→Thinking
 * cycles on one message that wasn't even addressed to kyto, only stoppable with
 * `@kyto!stop`, and each cycle billed the shared daily cap for a message kyto
 * had already decided to ignore.
 *
 * A skip is terminal by definition, so it's a stop condition, not a tool result.
 * Named here (not passed in per call site) because every attempt that offers the
 * tool must honour it — a new call site forgetting the flag would re-open the
 * loop — and `hasToolCall` simply never fires for a toolset without it.
 */
export const SKIP_TOOL_NAME = 'skip';

/**
 * Filled in as the attempt runs: `model` is the concrete slug OpenRouter's
 * auto-router resolved to (read off the response body), `calls` counts
 * completions calls (== agentic steps).
 */
export interface ResolvedModelHolder {
  calls?: number;
  model?: string;
}

/**
 * An image the model should SEE (not just be told about). Slack image
 * attachments become these on the user turn; the viewImage tool feeds sandbox
 * screenshots in mid-turn. The openai-compatible providers only render images
 * that ride in a USER message — a tool RESULT image is JSON-stringified and lost
 * — so both paths land as user-message file parts (see below).
 */
export interface ImageInput {
  bytes: Uint8Array;
  mediaType: string;
  /** Sandbox path or filename, shown to the model as a label. */
  path?: string;
}

// An image as an AI SDK file part. Bare Uint8Array data + an image media type is
// converted to an OpenAI `image_url` by the openai-compatible provider.
function imagePart(image: ImageInput) {
  return {
    data: image.bytes,
    mediaType: image.mediaType,
    type: 'file' as const,
  };
}

/**
 * Keep only images the SDK's `ModelMessage[]` schema will actually accept.
 *
 * `filePartSchema` requires `mediaType` to be a string and `data` to be one of
 * string / Uint8Array / ArrayBuffer / Buffer. A part that misses either is
 * rejected during prompt construction — BEFORE any request goes out — as
 * `Invalid prompt: The messages do not match the ModelMessage[] schema`, which
 * takes the WHOLE TURN down. Because nothing was ever sent, the failure is
 * identical on every rung: one bad attachment used to burn three models in 28
 * seconds (observed 2026-07-28) and still answer nobody.
 *
 * One unusable image must degrade to "that image was skipped", never to a dead
 * turn — so the invalid parts are dropped here and reported to the caller
 * instead of being handed to the SDK. The prompt text still describes the
 * attachment and its sandbox path, so the model can read the file with a tool.
 */
function usableImages(
  images: ImageInput[],
  onDropped?: (dropped: ImageInput[]) => void
): ImageInput[] {
  const kept: ImageInput[] = [];
  const dropped: ImageInput[] = [];
  for (const image of images) {
    const data: unknown = image?.bytes;
    const dataOk =
      typeof data === 'string' ||
      data instanceof Uint8Array ||
      data instanceof ArrayBuffer;
    const mediaTypeOk =
      typeof image?.mediaType === 'string' && image.mediaType.length > 0;
    if (dataOk && mediaTypeOk) {
      kept.push(image);
    } else {
      dropped.push(image);
    }
  }
  if (dropped.length > 0) {
    onDropped?.(dropped);
  }
  return kept;
}

const MODEL_FIELD = /"model"\s*:\s*"([^"]+)"/;
// The resolved slug appears in the first SSE chunk; don't scan forever.
const MAX_SCAN_BYTES = 16_384;

/**
 * Stream one model attempt: the whole multi-step agentic loop on a single
 * OpenAI-compatible endpoint. The per-instance `fetch` (no global patching —
 * the old interceptor died with Pi) tunes the request:
 *  - HackClub requests get `reasoning: { effort: 'medium' }` (the old Pi
 *    thinking level) — max_tokens comes from maxOutputTokens below, which
 *    defuses the proxy's pessimistic daily-spend projection;
 *  - every request gets 1-hour prompt-cache breakpoints (see addCacheControl);
 * and captures the resolved model slug into `holder` from a response clone.
 */
export function streamAttempt({
  abortSignal,
  activeTools,
  attempt,
  holder,
  images,
  getFreshImages,
  onDroppedImages,
  onError,
  onGatewayRetry,
  prompt,
  system,
  tools,
}: {
  abortSignal?: AbortSignal;
  /** Live view of the tool names exposed to the model (deferred loading). */
  activeTools?: () => string[] | undefined;
  attempt: ModelAttempt;
  holder: ResolvedModelHolder;
  /** Images to show the model on the user turn (e.g. Slack image attachments). */
  images?: ImageInput[];
  /**
   * Drained before each step for any images the model asked to view mid-turn
   * (the viewImage tool). Returns the not-yet-shown ones; they are injected as a
   * user message so the model actually sees them on the next step.
   */
  getFreshImages?: () => ImageInput[];
  /**
   * Called with any images dropped for being unrepresentable as an SDK file
   * part (see usableImages). Silence here would turn "kyto ignored my
   * screenshot" into an unexplainable one-off.
   */
  onDroppedImages?: (dropped: ImageInput[]) => void;
  /**
   * Called for every error the SDK swallows into the stream. Without it the SDK
   * default is `console.error`, which dumped an unstructured AI SDK stack blob
   * into the journal while the turn itself was logged as "complete" — the
   * failure that was impossible to attribute without a Slack transcript.
   */
  onError?: (error: unknown) => void;
  /**
   * Called when a step's request came back a gateway failure and is being sent
   * again (see gateway-retry). Purely observational — the retry happens either
   * way — but without it a proxy degrading from "flaky" to "down" looks like
   * nothing more than turns getting slower.
   */
  onGatewayRetry?: (info: GatewayRetryInfo) => void;
  prompt: string;
  system: string;
  tools: ToolSet;
}) {
  // "Sign in with ChatGPT" runs on the ChatGPT (Codex) backend, which speaks the
  // OpenAI **Responses API** (POST …/codex/responses) — NOT chat/completions,
  // which 404s there. So this attempt uses the OpenAI provider's `.responses()`
  // model instead of the openai-compatible chat client, with a fetch that forces
  // `store:false` (Codex rejects the request otherwise). Every other provider is
  // an ordinary openai-compatible chat endpoint.
  const isChatgpt = attempt.provider === CHATGPT_PROVIDER;
  const model = isChatgpt
    ? createOpenAI({
        apiKey: attempt.apiKey,
        baseURL: attempt.baseURL,
        fetch: codexFetch({
          attempt,
          holder,
          onGatewayRetry,
        }) as unknown as typeof fetch,
        // The ChatGPT account-scoping header; Authorization comes from apiKey.
        ...(attempt.headers ? { headers: attempt.headers } : {}),
      }).responses(attempt.model)
    : createOpenAICompatible({
        apiKey: attempt.apiKey,
        baseURL: attempt.baseURL,
        fetch: tunedFetch({
          attempt,
          holder,
          onGatewayRetry,
        }) as unknown as typeof fetch,
        // Extra per-attempt headers. Authorization is set from apiKey.
        ...(attempt.headers ? { headers: attempt.headers } : {}),
        name: attempt.provider,
      }).chatModel(attempt.model);
  // Attachment images ride in the user turn (put BEFORE the text so the cache
  // breakpoint still lands on the trailing text block). With none, keep the
  // plain string prompt so the default path is byte-identical to before.
  const initialImages = usableImages(images ?? [], onDroppedImages);
  const promptInput =
    initialImages.length > 0
      ? {
          messages: [
            {
              content: [
                ...initialImages.map(imagePart),
                { text: prompt, type: 'text' as const },
              ],
              role: 'user' as const,
            },
          ] satisfies ModelMessage[],
        }
      : { prompt };
  return streamText({
    ...promptInput,
    abortSignal,
    // Cap output on every metered path: HackClub (pessimistic spend projection)
    // and a user's own BYOK key (real tokens on THEIR account) — reasoning
    // models otherwise burn unbounded thinking tokens on someone's bill.
    ...(attempt.provider === HACKCLUB_PROVIDER ||
    attempt.byokProvider !== undefined
      ? { maxOutputTokens: MAX_OUTPUT_TOKENS }
      : {}),
    // We run our own fallback chain across providers, so the SDK's default of 3
    // internal tries per attempt just triples the wait before we can route
    // away from a rate-limited or budget-exhausted proxy. One retry still
    // absorbs a genuinely transient blip.
    maxRetries: 1,
    // A tool call whose arguments were cut off mid-JSON (the model tried to
    // write a huge file / post a huge message and hit maxOutputTokens) otherwise
    // dies as an unrecoverable AI_JSONParseError.
    experimental_repairToolCall: repairTruncatedToolCall,
    model,
    // Mirror the Codex client on a ChatGPT turn. `store: false` has to be told
    // to the SDK, not just forced onto the wire body (codexFetch): knowing it,
    // the provider asks for `include: reasoning.encrypted_content` and replays
    // reasoning items WITH their payload instead of by `rs_…` id. Without it
    // every multi-step tool turn died at the second step with a 404 "Item with
    // id 'rs_…' not found. Items are not persisted when `store` is set to
    // false" — which is what made ChatGPT turns fall back to the shared models
    // so much more often than the same account does in Codex itself.
    ...(isChatgpt
      ? {
          providerOptions: {
            openai: { reasoningSummary: 'auto', store: false },
          },
        }
      : {}),
    ...(onError ? { onError: ({ error }) => onError(error) } : {}),
    ...(activeTools || getFreshImages
      ? {
          // Gate deferred tools per step AND inject any images the model asked to
          // view: the SDK renders images only in a user message, so a screenshot
          // the model loaded mid-turn is appended as a user turn here (the
          // override carries forward, so it stays visible on later steps).
          prepareStep: ({ messages }) => {
            const result: {
              activeTools?: never[];
              messages?: ModelMessage[];
            } = {};
            if (activeTools) {
              result.activeTools = activeTools() as never[] | undefined;
            }
            // Same filter as the initial images: prepareStep's messages are not
            // re-validated by the SDK, so a bad part here dies later and less
            // legibly, in prompt CONVERSION rather than validation.
            const fresh = usableImages(
              getFreshImages?.() ?? [],
              onDroppedImages
            );
            if (fresh.length > 0) {
              const label = fresh
                .map((image) => image.path ?? 'image')
                .join(', ');
              result.messages = [
                ...messages,
                {
                  content: [
                    ...fresh.map(imagePart),
                    {
                      text: `[You are now viewing the image(s) you loaded: ${label}]`,
                      type: 'text' as const,
                    },
                  ],
                  role: 'user' as const,
                },
              ];
            }
            return result;
          },
        }
      : {}),
    // Either bound ends the attempt: the step ceiling, or a deliberate skip
    // (see SKIP_TOOL_NAME — without this the "no reply" decision was made over
    // and over on the same message).
    stopWhen: [stepCountIs(MAX_STEPS), hasToolCall(SKIP_TOOL_NAME)],
    system,
    tools,
  });
}

/**
 * Salvage a tool call whose argument JSON was cut off mid-stream — the model
 * tried to emit a large `content` (writeFile) or `text` (postMessage) and ran
 * into `maxOutputTokens`, so the arguments arrive as an unterminated JSON
 * fragment. The SDK's default is to throw `InvalidToolInputError`, which surfaces
 * as an unrecoverable error and strands the turn.
 *
 * Closing the open string/array/object brackets turns the fragment back into
 * valid JSON, so the call runs with the content that DID arrive rather than the
 * turn dying. The model sees the (short) result and can continue the file with
 * an append. Returns null when the fragment can't be closed into valid JSON, in
 * which case the SDK's normal error path takes over.
 */
const repairTruncatedToolCall: ToolCallRepairFunction<ToolSet> = ({
  toolCall,
}) => {
  const closed = closeTruncatedJson(toolCall.input);
  return Promise.resolve(
    closed === null ? null : { ...toolCall, input: closed }
  );
};

// Walk the fragment tracking string/escape state and the bracket stack, then
// append whatever closers are still owed. A fragment that ends mid-escape or
// mid-key is dropped back to the last safe point first.
function closeTruncatedJson(input: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? '}' : ']');
    } else if (char === '}' || char === ']') {
      stack.pop();
    }
  }
  // A trailing backslash would escape the quote we're about to add.
  let repaired = escaped ? input.slice(0, -1) : input;
  if (inString) {
    repaired += '"';
  } else {
    // A fragment cut after a separator ("a":1,) can't be closed as-is.
    repaired = repaired.replace(/,\s*$/, '');
  }
  while (stack.length > 0) {
    repaired += stack.pop();
  }
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

// Fetch for the ChatGPT (Codex) Responses API. The AI SDK's OpenAI provider
// already sends the right Responses shape (`input` as a list, `stream:true`),
// but the Codex backend additionally REQUIRES `store:false` (it 400s "Store must
// be set to false" otherwise). So this injects that into every /responses body
// and counts the call as an agentic step. The account-scoping header rides on
// the provider's `headers`, and Authorization on `apiKey`.
function codexFetch({
  attempt,
  holder,
  onGatewayRetry,
}: {
  attempt: ModelAttempt;
  holder: ResolvedModelHolder;
  onGatewayRetry?: (info: GatewayRetryInfo) => void;
}): FetchLike {
  return async (input, init) => {
    const url = requestUrl(input);
    if (!url.includes('/responses')) {
      return fetch(input as Parameters<typeof fetch>[0], init);
    }
    holder.calls = (holder.calls ?? 0) + 1;
    holder.model ??= attempt.model;
    const raw = await readRequestBody(input, init);
    if (raw === undefined) {
      return fetch(input as Parameters<typeof fetch>[0], init);
    }
    let body = raw;
    try {
      // Belt and braces: the provider already sets store:false from
      // providerOptions (which is what makes it request encrypted reasoning
      // content), but Codex rejects a stored request outright, so pin it here
      // too in case an SDK update stops threading the option through.
      const payload = JSON.parse(raw) as Record<string, unknown>;
      payload.store = false;
      body = JSON.stringify(payload);
    } catch {
      // Un-parseable body: send it through unchanged rather than dropping it.
      return fetch(input as Parameters<typeof fetch>[0], init);
    }
    const source =
      init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const headers = new Headers(
      source as ConstructorParameters<typeof Headers>[0]
    );
    headers.delete('content-length');
    return fetchWithGatewayRetry(
      url,
      {
        ...init,
        body,
        headers,
        method:
          init?.method ?? (input instanceof Request ? input.method : 'POST'),
        signal:
          init?.signal ?? (input instanceof Request ? input.signal : undefined),
      },
      { onRetry: onGatewayRetry }
    );
  };
}

function tunedFetch({
  attempt,
  holder,
  onGatewayRetry,
}: {
  attempt: ModelAttempt;
  holder: ResolvedModelHolder;
  onGatewayRetry?: (info: GatewayRetryInfo) => void;
}): FetchLike {
  // Gemini 3.x attaches an encrypted `thought_signature` to every function call
  // and REQUIRES it echoed back on the next turn, or it 400s ("Function call is
  // missing a thought_signature"). The OpenAI-compat SDK drops that field when
  // it replays assistant tool calls, so we capture signatures off each response
  // (keyed by tool-call id) and re-inject them into subsequent request bodies.
  // Scoped to this attempt's closure so it persists across the attempt's steps.
  const thoughtSignatures = new Map<string, string>();
  const isGemini = attempt.provider === GEMINI_PROVIDER;
  return async (input, init) => {
    const url = requestUrl(input);
    let callInput = input;
    let callInit = init;
    if (url.includes('/chat/completions')) {
      holder.calls = (holder.calls ?? 0) + 1;
      const tuned = tuneBody(
        await readRequestBody(input, init),
        attempt,
        isGemini ? thoughtSignatures : undefined
      );
      if (tuned) {
        const source =
          init?.headers ??
          (input instanceof Request ? input.headers : undefined);
        // Recompute Content-Length: the tuned body is longer, and a stale
        // length truncates the request on the wire (silently dropping the
        // appended plugins — the old "allowlist ignored" bug).
        const headers = new Headers(
          source as ConstructorParameters<typeof Headers>[0]
        );
        headers.delete('content-length');
        callInput = url;
        callInit = {
          ...init,
          body: tuned,
          headers,
          method:
            init?.method ?? (input instanceof Request ? input.method : 'POST'),
          signal:
            init?.signal ??
            (input instanceof Request ? input.signal : undefined),
        };
      }
    }
    const response = await fetchWithGatewayRetry(callInput, callInit, {
      onRetry: onGatewayRetry,
    });
    if (response.body && !holder.model && url.includes('/chat/completions')) {
      // clone() tees: the original streams to the SDK untouched; we scan the
      // copy in the background for the resolved model slug.
      readResolvedModel(
        response.clone().body as ReadableStream<Uint8Array>
      ).then((model) => {
        if (model && !holder.model) {
          holder.model = model;
        }
      });
    }
    if (isGemini && response.body && url.includes('/chat/completions')) {
      // Capture this response's thought signatures (background tee) so the next
      // request can echo them back — see the closure comment above.
      captureThoughtSignatures(
        response.clone().body as ReadableStream<Uint8Array>,
        thoughtSignatures
      ).catch(() => undefined);
    }
    return response;
  };
}

// Models whose deployment REQUIRES an exact `top_p`, rejecting the request
// outright otherwise: `{"error":{"message":"top_p must be 0.95 for this
// model","type":"invalid_request_error"}}` with a 400. The AI SDK sends no
// `top_p` unless asked to, and such a provider treats "absent" as wrong rather
// than substituting its own default, so the rung is unusable from the day it is
// added — visible only as a 400 in the journal partway down a fallback walk.
// Keyed by model slug; empty today (the DigitalOcean roster that needed it is
// gone), kept because the failure mode is invisible without it.
const REQUIRED_TOP_P: Record<string, number> = {};

function tuneBody(
  raw: string | undefined,
  attempt: ModelAttempt,
  thoughtSignatures?: Map<string, string>
): string | null {
  if (raw === undefined) {
    return null;
  }
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    let changed = false;
    // Gemini: re-attach captured thought signatures to assistant tool calls so
    // the API accepts the replayed history (see tunedFetch's closure comment).
    if (
      thoughtSignatures &&
      injectThoughtSignatures(payload, thoughtSignatures)
    ) {
      changed = true;
    }
    // Some deployments pin a sampling parameter and reject anything else —
    // including OMITTING it, which is what the SDK does by default. See
    // REQUIRED_TOP_P: a rung that needs this and doesn't get it 400s on every
    // single turn, and the fallback walk silently skips straight past it.
    const requiredTopP = REQUIRED_TOP_P[attempt.model];
    if (requiredTopP !== undefined && payload.top_p !== requiredTopP) {
      payload.top_p = requiredTopP;
      changed = true;
    }
    if (
      attempt.provider === HACKCLUB_PROVIDER &&
      payload.reasoning === undefined
    ) {
      payload.reasoning = { effort: 'medium' };
      changed = true;
    }
    // Prompt caching: mark the large, stable prefix (system prompt + tool
    // schemas) and the moving conversation tail with cache_control breakpoints.
    // Anthropic/Gemini honor these for ~10x cheaper cached reads (verified
    // through the HackClub proxy); providers that don't support explicit
    // caching (OpenAI, DeepSeek, GLM, Kimi, …) safely ignore them and auto-cache
    // on their own. Applied to every attempt — harmless where unsupported.
    if (addCacheControl(payload)) {
      changed = true;
    }
    return changed ? JSON.stringify(payload) : null;
  } catch {
    return null;
  }
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

async function readRequestBody(
  input: string | URL | Request,
  init: RequestInit | undefined
): Promise<string | undefined> {
  const body = init?.body;
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  if (input instanceof Request) {
    return await input
      .clone()
      .text()
      .catch(() => undefined);
  }
  return;
}

// Re-attach captured Gemini thought signatures to the assistant tool calls in a
// request body, keyed by tool-call id. Google requires each replayed function
// call to carry the signature it was originally issued with.
function injectThoughtSignatures(
  payload: Record<string, unknown>,
  signatures: Map<string, string>
): boolean {
  if (signatures.size === 0 || !Array.isArray(payload.messages)) {
    return false;
  }
  let changed = false;
  for (const message of payload.messages as Record<string, unknown>[]) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
      continue;
    }
    for (const call of message.tool_calls as Record<string, unknown>[]) {
      const id = typeof call.id === 'string' ? call.id : undefined;
      const signature = id ? signatures.get(id) : undefined;
      if (!signature) {
        continue;
      }
      const existing =
        typeof call.extra_content === 'object' && call.extra_content
          ? (call.extra_content as Record<string, unknown>)
          : {};
      call.extra_content = {
        ...existing,
        google: { thought_signature: signature },
      };
      changed = true;
    }
  }
  return changed;
}

// Max bytes to scan of a Gemini response for thought signatures — they ride on
// the tool-call delta, which is near the start, but text/reasoning can precede
// it, so allow generous headroom without reading an unbounded stream.
const MAX_SIGNATURE_SCAN_BYTES = 512 * 1024;

// Tee of a Gemini streaming response: parse SSE `data:` lines and record each
// tool call's `extra_content.google.thought_signature` by tool-call id.
async function captureThoughtSignatures(
  body: ReadableStream<Uint8Array>,
  signatures: Map<string, string>
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let scanned = 0;
  try {
    while (scanned < MAX_SIGNATURE_SCAN_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      scanned += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        recordSignatureLine(buffer.slice(0, newline), signatures);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
  } catch {
    // Best-effort: a missed signature just re-surfaces the original 400, which
    // the fallback machinery already handles.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function recordSignatureLine(
  line: string,
  signatures: Map<string, string>
): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) {
    return;
  }
  const data = trimmed.slice('data:'.length).trim();
  if (!data || data === '[DONE]') {
    return;
  }
  let chunk: unknown;
  try {
    chunk = JSON.parse(data);
  } catch {
    return;
  }
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) {
    return;
  }
  for (const choice of choices) {
    const toolCalls = (choice as { delta?: { tool_calls?: unknown } }).delta
      ?.tool_calls;
    if (!Array.isArray(toolCalls)) {
      continue;
    }
    for (const call of toolCalls) {
      const id = (call as { id?: unknown }).id;
      const signature = (
        call as {
          extra_content?: { google?: { thought_signature?: unknown } };
        }
      ).extra_content?.google?.thought_signature;
      if (typeof id === 'string' && typeof signature === 'string') {
        signatures.set(id, signature);
      }
    }
  }
}

async function readResolvedModel(
  body: ReadableStream<Uint8Array>
): Promise<string | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let scanned = '';
  try {
    while (scanned.length < MAX_SCAN_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      scanned += decoder.decode(value, { stream: true });
      const match = scanned.match(MODEL_FIELD);
      if (match) {
        return match[1];
      }
    }
  } catch {
    // Capturing the model is purely cosmetic.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return;
}
