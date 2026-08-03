import { randomBytes } from 'node:crypto';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';

// A host-side, READ-ONLY Slack proxy the sandbox can call so a script can batch
// Slack reads (e.g. "who is in the most channels") without N LLM round-trips —
// and without the bot token ever entering the sandbox. The sandbox authenticates
// with a per-turn secret; the proxy attaches the real token and forwards ONLY
// the allow-listed read methods. Even a leaked per-turn secret can therefore
// never post, delete, or mutate anything.

// Read-only Web API methods. Deliberately excludes every write/admin method
// (chat.*, conversations.invite/kick/archive, files upload, admin.*, etc.).
const READ_ONLY_METHODS = new Set<string>([
  'auth.test',
  'bookmarks.list',
  'conversations.history',
  'conversations.info',
  'conversations.members',
  'conversations.replies',
  'conversations.list',
  'emoji.list',
  'pins.list',
  'reactions.get',
  'reactions.list',
  'team.info',
  'team.profile.get',
  'usergroups.list',
  'usergroups.users.list',
  'users.conversations',
  'users.getPresence',
  'users.info',
  'users.list',
  'users.lookupByEmail',
  'users.profile.get',
]);

// Where the proxy is mounted on the public sites server.
export const SLACK_PROXY_PREFIX = '/_slackapi/';

const PROXY_TOKEN_TTL_MS = 15 * 60 * 1000;

// Per-turn secrets → expiry. In-memory only; a restart invalidates all (turns
// don't survive restarts anyway).
const tokens = new Map<string, number>();

/** Mint a per-turn proxy secret valid for the turn (bounded by a TTL). */
export function registerProxyToken(): string {
  const secret = randomBytes(24).toString('base64url');
  tokens.set(secret, Date.now() + PROXY_TOKEN_TTL_MS);
  return secret;
}

export function revokeProxyToken(secret: string | undefined): void {
  if (secret) {
    tokens.delete(secret);
  }
}

function isValidToken(secret: string | undefined): boolean {
  if (!secret) {
    return false;
  }
  const expiry = tokens.get(secret);
  if (!expiry) {
    return false;
  }
  if (Date.now() > expiry) {
    tokens.delete(secret);
    return false;
  }
  return true;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

/**
 * Handle a request to the Slack proxy, or return null if the path isn't ours
 * (so the caller falls through to normal static-site serving). Only reachable
 * over the public sites host; every call is secret-gated and method-gated.
 */
export async function handleSlackProxy(
  request: Request,
  pathname: string
): Promise<Response | null> {
  if (!pathname.startsWith(SLACK_PROXY_PREFIX)) {
    return null;
  }
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed', ok: false }, 405);
  }
  const auth = request.headers.get('authorization') ?? '';
  const secret = auth.replace(/^Bearer\s+/i, '').trim();
  if (!isValidToken(secret)) {
    return json({ error: 'unauthorized', ok: false }, 401);
  }
  const method = decodeURIComponent(pathname.slice(SLACK_PROXY_PREFIX.length));
  if (!READ_ONLY_METHODS.has(method)) {
    return json({ error: `method_not_allowed: ${method}`, ok: false }, 403);
  }
  let args: Record<string, unknown> = {};
  const rawBody = await request.text().catch(() => '');
  if (rawBody.trim()) {
    try {
      args = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return json({ error: 'invalid_json_body', ok: false }, 400);
    }
  }
  try {
    const result = await slack.webClient.apiCall(method, args);
    return json(result, 200);
  } catch (error) {
    logger.warn({ err: error, method }, '[slack-proxy] call failed');
    return json(
      {
        error: error instanceof Error ? error.message : 'call_failed',
        ok: false,
      },
      502
    );
  }
}

/** The allow-listed method names (for tool/prompt documentation). */
export const readOnlySlackMethods = (): string[] =>
  [...READ_ONLY_METHODS].sort();

/** Env that points a sandbox command at the proxy. Re-sent on every command, so
 * a resumed sandbox never carries a stale (revoked) token from an older turn. */
export function slackProxyEnv(
  secret: string,
  publicHost: string
): Record<string, string> {
  return {
    KYTO_SLACK_PROXY: `https://${publicHost}/_slackapi`,
    KYTO_SLACK_PROXY_TOKEN: secret,
  };
}

/**
 * Installs `slack <method> [jsonArgs]` as a real executable on PATH, so ANY
 * command in the sandbox can query Slack read-only — the plain `bash` tool and a
 * recurring `bash` reminder, not just the `slackScript` tool (which used to
 * prepend the helper as a shell function, making it invisible everywhere else).
 *
 * It reads the proxy URL and token from the environment at call time, which is
 * what lets a sandbox outlive any single turn's token: each command is handed a
 * fresh one. Idempotent — this reruns on every materialization.
 */
export function slackHelperInstall(): string {
  return `cat > /usr/local/bin/slack <<'KYTO_SLACK_HELPER'
#!/usr/bin/env bash
set -euo pipefail
if [ -z "\${KYTO_SLACK_PROXY:-}" ] || [ -z "\${KYTO_SLACK_PROXY_TOKEN:-}" ]; then
  echo '{"ok":false,"error":"slack proxy is not available in this context"}' >&2
  exit 1
fi
method="\${1:?usage: slack <method> [jsonArgs]}"
body="\${2:-{}}"
curl -sS -X POST "$KYTO_SLACK_PROXY/$method" \\
  -H "Authorization: Bearer $KYTO_SLACK_PROXY_TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d "$body"
KYTO_SLACK_HELPER
chmod +x /usr/local/bin/slack`;
}
