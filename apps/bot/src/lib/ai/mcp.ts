import type { UserMcpServer } from '@repo/db/queries';
import type { Logger } from '@repo/logging/logger';
import { jsonSchema, type Tool, tool } from 'ai';
import { z } from 'zod';

// Minimal MCP client over the Streamable HTTP transport (JSON-RPC 2.0 via
// POST). Hand-rolled on purpose: it is ~150 lines, has zero dependencies, and
// only needs initialize / tools/list / tools/call. Legacy SSE-only servers are
// not supported — Slack gives the bot no channel to a user's local machine
// anyway, so only remote HTTP(S) servers can ever work here.

const PROTOCOL_VERSION = '2025-06-18';
const CONNECT_TIMEOUT_MS = 8000;
const CALL_TIMEOUT_MS = 60_000;
// Cached tool listings so turns don't pay a discovery round-trip per turn.
const LIST_CACHE_TTL_MS = 10 * 60 * 1000;

const toolListSchema = z.object({
  tools: z.array(
    z.looseObject({
      description: z.string().optional(),
      inputSchema: z.record(z.string(), z.unknown()).optional(),
      name: z.string(),
    })
  ),
});

const callResultSchema = z.looseObject({
  content: z
    .array(
      z.looseObject({
        text: z.string().optional(),
        type: z.string(),
      })
    )
    .optional(),
  isError: z.boolean().optional(),
});

export interface McpToolInfo {
  description?: string;
  inputSchema?: Record<string, unknown>;
  name: string;
}

const listCache = new Map<string, { at: number; tools: McpToolInfo[] }>();

export class McpConnection {
  private readonly server: UserMcpServer;
  private sessionId: string | undefined;
  private initialized: Promise<void> | undefined;
  private nextId = 1;

  constructor({ server }: { server: UserMcpServer }) {
    this.server = server;
  }

  private async rpc(
    method: string,
    params: unknown,
    { notification = false, timeoutMs = CALL_TIMEOUT_MS } = {}
  ): Promise<unknown> {
    const id = notification ? undefined : this.nextId++;
    const response = await fetch(this.server.url, {
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        ...(notification ? {} : { id }),
      }),
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...(this.server.authorization
          ? { authorization: this.server.authorization }
          : {}),
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const session = response.headers.get('mcp-session-id');
    if (session) {
      this.sessionId = session;
    }
    if (!response.ok) {
      throw new Error(`MCP server responded ${response.status} for ${method}.`);
    }
    if (notification) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('text/event-stream')
      ? await readSseResponse(response, id as number)
      : await response.json();
    const message = payload as {
      error?: { code?: number; message?: string };
      result?: unknown;
    };
    if (message.error) {
      throw new Error(
        `MCP ${method} failed: ${message.error.message ?? 'unknown error'}`
      );
    }
    return message.result;
  }

  private ensureInitialized(): Promise<void> {
    this.initialized ??= (async () => {
      await this.rpc(
        'initialize',
        {
          capabilities: {},
          clientInfo: { name: 'kyto', version: '1.0.0' },
          protocolVersion: PROTOCOL_VERSION,
        },
        { timeoutMs: CONNECT_TIMEOUT_MS }
      );
      await this.rpc('notifications/initialized', {}, { notification: true });
    })();
    return this.initialized;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const cached = listCache.get(this.server.url);
    if (cached && Date.now() - cached.at < LIST_CACHE_TTL_MS) {
      return cached.tools;
    }
    await this.ensureInitialized();
    const result = toolListSchema.parse(
      await this.rpc('tools/list', {}, { timeoutMs: CONNECT_TIMEOUT_MS })
    );
    const tools = result.tools.map((entry) => ({
      description: entry.description,
      inputSchema: entry.inputSchema as Record<string, unknown> | undefined,
      name: entry.name,
    }));
    listCache.set(this.server.url, { at: Date.now(), tools });
    return tools;
  }

  async callTool(name: string, args: unknown): Promise<string> {
    await this.ensureInitialized();
    const result = callResultSchema.parse(
      await this.rpc('tools/call', { arguments: args ?? {}, name })
    );
    const text = (result.content ?? [])
      .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
    if (result.isError) {
      throw new Error(text || 'MCP tool call failed.');
    }
    return text || JSON.stringify(result);
  }

  async close(): Promise<void> {
    if (!this.sessionId) {
      return;
    }
    await fetch(this.server.url, {
      headers: {
        ...(this.server.authorization
          ? { authorization: this.server.authorization }
          : {}),
        'mcp-session-id': this.sessionId,
      },
      method: 'DELETE',
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);
  }
}

async function readSseResponse(
  response: Response,
  id: number
): Promise<unknown> {
  const body = response.body;
  if (!body) {
    throw new Error('MCP SSE response had no body.');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      for (const event of buffer.split('\n\n').slice(0, -1)) {
        const data = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (!data) {
          continue;
        }
        const parsed = JSON.parse(data) as { id?: unknown };
        if (parsed.id === id) {
          return parsed;
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new Error('MCP SSE response ended without a matching reply.');
}

/**
 * Build namespaced ai tools for one user's MCP servers. Listing uses the
 * shared schema cache (one discovery round-trip per server per 10 minutes);
 * calls open a per-turn connection lazily. Returns the tools plus a `close`
 * to run at turn end. A dead server degrades that turn's toolset, not the bot.
 */
export async function buildMcpTools({
  logger,
  servers,
}: {
  logger: Logger;
  servers: UserMcpServer[];
}): Promise<{ close: () => Promise<void>; tools: Record<string, Tool> }> {
  const connections: McpConnection[] = [];
  const tools: Record<string, Tool> = {};
  await Promise.all(
    servers.map(async (server) => {
      const connection = new McpConnection({ server });
      try {
        const infos = await connection.listTools();
        connections.push(connection);
        for (const info of infos) {
          const toolName = `mcp_${server.name}_${info.name}`.replaceAll(
            /[^\w-]/g,
            '_'
          );
          tools[toolName] = tool({
            description:
              info.description ??
              `Tool ${info.name} on the ${server.name} MCP server.`,
            inputSchema: jsonSchema(
              (info.inputSchema ?? {
                properties: {},
                type: 'object',
              }) as never
            ),
            execute: (args: unknown) => connection.callTool(info.name, args),
          });
        }
      } catch (error) {
        logger.warn(
          { err: error, server: server.name, url: server.url },
          '[mcp] server unavailable this turn'
        );
      }
    })
  );
  return {
    close: async () => {
      await Promise.all(connections.map((connection) => connection.close()));
    },
    tools,
  };
}
