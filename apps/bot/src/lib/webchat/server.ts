/**
 * Web chat server — the handoff that makes the Forkie WEBSITE talk to the same
 * agent brain that powers the Slack bot.
 *
 * Exposes a tiny chat API (POST /api/chat, SSE streaming) that reuses the exact
 * same model pipeline as the Slack agent: @repo/ai's `streamAttempt` with the
 * same PRIMARY_ATTEMPT → LEADERBOARD_FALLBACK chain (same keys, same quota,
 * same fallbacks) and the same core + personality prompts. The website is
 * literally another frontend for the same agent.
 *
 * Slack-specific tools (posting to a thread, reacting, reading Slack history)
 * are intentionally not wired here — they don't map to a web chat. Tool use
 * (web search, sandboxed code, images) can plug into the `tools` set passed to
 * streamAttempt when ready; the loop itself is identical.
 *
 * Endpoints:
 *   GET  /health          → { ok: true }
 *   POST /api/chat        → SSE stream of {delta} events, then {done}/{error}.
 *                          Body: { messages: [{role, content}], conversationId? }
 *                          Optional auth: x-web-chat-secret header (see
 *                          WEB_CHAT_SECRET).
 */

import {
  LEADERBOARD_FALLBACK,
  type ModelAttempt,
  PRIMARY_ATTEMPT,
  type ResolvedModelHolder,
  streamAttempt,
} from '@repo/ai';
import { corePrompt } from '@repo/ai/prompts/core';
import { personalityPrompt } from '@repo/ai/prompts/personality';
import { env } from '@/env';
import logger from '@/lib/logger';

const WEB_SYSTEM_PROMPT = [
  corePrompt,
  personalityPrompt,
  `\
<context>
You are Forkie — the SAME AI agent that runs in Slack for your owner, Tony Di
Bonfacio, who personally built and runs you. This website is just another
frontend for you, so be yourself: calm, smart, good-natured, a little witty.
Write naturally, like a person chatting; never use em dashes. Match the user's
energy and language. The current date and time is ${new Date().toISOString()}.
</context>`,
].join('\n\n');

interface ChatMessage {
  role: string;
  content: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-web-chat-secret',
  'Access-Control-Max-Age': '86400',
};

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function respond(body: string, status: number): Response {
  return new Response(body, { status, headers: CORS_HEADERS });
}

/** Flatten prior messages into a transcript and take the last as the user turn. */
function buildPrompt(messages: ChatMessage[]): string {
  const usable = messages.filter((m) => m.role !== 'system' && m.content);
  const transcript = usable
    .slice(0, -1)
    .map((m) => `${m.role === 'user' ? 'user' : 'assistant'}: ${m.content}`)
    .join('\n\n');
  const last = usable.at(-1);
  return transcript ? `${transcript}\n\nuser: ${last?.content ?? ''}` : (last?.content ?? '');
}

async function handleChat(request: Request): Promise<Response> {
  if (
    env.WEB_CHAT_SECRET &&
    request.headers.get('x-web-chat-secret') !== env.WEB_CHAT_SECRET
  ) {
    return respond('Unauthorized', 401);
  }

  let body: { messages?: ChatMessage[]; conversationId?: string };
  try {
    body = (await request.json()) as { messages?: ChatMessage[]; conversationId?: string };
  } catch {
    return respond('Bad request: invalid JSON', 400);
  }
  const messages = (body?.messages ?? []).filter(
    (m) => typeof m?.content === 'string' && m.content.trim()
  );
  if (messages.length === 0) {
    return respond('Bad request: messages required', 400);
  }

  const prompt = buildPrompt(messages);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(sse(event, data)));

      const attempts: ModelAttempt[] = [PRIMARY_ATTEMPT, ...LEADERBOARD_FALLBACK];
      let lastError: unknown = null;
      let streamedAnything = false;
      let fullText = '';
      let usedModel: string | undefined;

      for (const attempt of attempts) {
        const holder: ResolvedModelHolder = {};
        try {
          send('attempt', { model: attempt.model, provider: attempt.provider });
          const result = streamAttempt({
            abortSignal: request.signal,
            attempt,
            holder,
            prompt,
            system: WEB_SYSTEM_PROMPT,
            tools: {},
            onError: (error) =>
              logger.warn({ err: error, model: attempt.model }, '[webchat] stream error'),
          });
          for await (const delta of result.textStream) {
            if (delta) {
              streamedAnything = true;
              fullText += delta;
              send('delta', { delta });
            }
          }
          usedModel = holder.model ?? attempt.model;
          break;
        } catch (error) {
          lastError = error;
          logger.warn({ err: error, model: attempt.model }, '[webchat] attempt failed');
          if (streamedAnything) {
            // Partial text already went to the client; don't restart on a new model.
            break;
          }
        }
      }

      if (!streamedAnything || !fullText.trim()) {
        send('error', {
          error: 'no response from any model',
          detail: lastError instanceof Error ? lastError.message : String(lastError ?? ''),
        });
      } else {
        send('done', { text: fullText, model: usedModel });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      ...CORS_HEADERS,
    },
  });
}

/**
 * Start the web chat server on WEB_CHAT_PORT. Independent of the sites server
 * and of Slack socket mode, so it can run even where hosting is disabled.
 */
export async function startWebChatServer(): Promise<void> {
  if (!env.WEB_CHAT_ENABLED) {
    logger.info('[webchat] disabled (WEB_CHAT_ENABLED=false)');
    return;
  }

  Bun.serve({
    port: env.WEB_CHAT_PORT,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (pathname === '/health') {
        return Response.json({ ok: true }, { headers: CORS_HEADERS });
      }
      if (pathname === '/api/chat' && request.method === 'POST') {
        return handleChat(request);
      }
      return respond('Not found', 404);
    },
  });
  logger.info({ port: env.WEB_CHAT_PORT }, '[webchat] listening');
}
