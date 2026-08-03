import { pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

// Per-user remote MCP servers, managed from the App Home tab. Each user's
// servers are connected lazily per turn and their tools exposed (namespaced)
// only on that user's turns. Only HTTP(S) transports are possible — Slack
// gives the bot no channel to a server on the user's own machine.
export const userMcpServers = pgTable(
  'user_mcp_servers',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id').notNull(),
    // Short handle used to namespace tools: `mcp_<name>_<tool>`.
    name: text('name').notNull(),
    url: text('url').notNull(),
    // Optional Authorization header value (e.g. "Bearer xyz"), stored as-is.
    authorization: text('authorization'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique('user_mcp_servers_user_name').on(table.userId, table.name)]
);

export type UserMcpServer = typeof userMcpServers.$inferSelect;
