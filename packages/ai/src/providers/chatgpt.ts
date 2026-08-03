import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ModelAttempt } from './attempts';

/**
 * "Sign in with ChatGPT" — a user links their own ChatGPT account (Plus / Pro /
 * Team) over OAuth, and their turns then run on that subscription instead of
 * kyto's shared models. The stored credential is a pair of OAuth access/refresh
 * tokens (encrypted exactly like a BYOK key); the resulting `ModelAttempt` is an
 * ordinary OpenAI-compatible endpoint pointed at the ChatGPT backend, so nothing
 * in `streamAttempt` needs to know it came from OAuth — EXCEPT that the access
 * token is short-lived, so the bot refreshes it just before each turn (see
 * apps/bot/src/lib/chatgpt).
 *
 * The OAuth client is OpenAI's own Codex CLI client (`clientId` below), whose
 * only registered redirect URI is a loopback (`localhost:1455`) a server bot
 * cannot listen on. So the Slack flow is a manual code paste: kyto hands the
 * user the authorize URL, they sign in, their browser lands on the (dead)
 * localhost callback carrying `?code=&state=`, and they paste that URL back into
 * a kyto modal, which finishes the PKCE exchange host-side.
 */
export const CHATGPT_PROVIDER = 'chatgpt-oauth';

/**
 * A recent Codex client version. Sent as the `version` header on turns and as
 * `?client_version=` on the model-catalog call — the backend uses it to decide
 * which models an account may see, so a stale value quietly narrows the list.
 */
export const CODEX_CLIENT_VERSION = '0.144.1';

export const CHATGPT_OAUTH = {
  apiBaseUrl: 'https://chatgpt.com/backend-api/codex',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  // OpenAI's Codex CLI public client id. Overridable in case OpenAI rotates it.
  clientId:
    process.env.CHATGPT_OAUTH_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann',
  redirectUri: 'http://localhost:1455/auth/callback',
  scope: 'openid profile email offline_access',
  tokenUrl: 'https://auth.openai.com/oauth/token',
} as const;

export interface ChatgptPkce {
  challenge: string;
  verifier: string;
}

/** A PKCE verifier/challenge pair (S256), minted per link attempt. */
export function generatePkce(): ChatgptPkce {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { challenge, verifier };
}

/** Opaque anti-CSRF state, echoed back on the callback and checked. */
export function generateOauthState(): string {
  return randomBytes(16).toString('base64url');
}

/** The authorize URL the user opens to sign in with ChatGPT. */
export function buildChatgptAuthUrl(input: {
  codeChallenge: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: CHATGPT_OAUTH.clientId,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    // Matches the official Codex flow so the account picker and org claims behave
    // the same way.
    codex_cli_simplified_flow: 'true',
    id_token_add_organizations: 'true',
    redirect_uri: CHATGPT_OAUTH.redirectUri,
    response_type: 'code',
    scope: CHATGPT_OAUTH.scope,
    state: input.state,
  });
  return `${CHATGPT_OAUTH.authorizeUrl}?${params.toString()}`;
}

/**
 * Build the model attempt for a linked ChatGPT account. `accessToken` is the
 * short-lived OAuth token (already refreshed by the caller); `accountId` scopes
 * the request to the right account and is sent as a header the ChatGPT backend
 * expects. Deliberately carries NO `byokProvider`, so the metered-provider token
 * cap in agent.ts (built for HackClub) does not apply — the ChatGPT
 * backend is not always happy with an injected `max_tokens`. Prompt caching
 * still applies (harmless where unsupported); reasoning-effort injection does
 * not (it is gated to HackClub).
 */
export function chatgptAttempt(input: {
  accountId?: string | null;
  accessToken: string;
  model: string;
}): ModelAttempt | undefined {
  if (!(input.accessToken && input.model)) {
    return;
  }
  return {
    apiKey: input.accessToken,
    baseURL: CHATGPT_OAUTH.apiBaseUrl,
    headers: {
      ...(input.accountId ? { 'chatgpt-account-id': input.accountId } : {}),
      ...codexClientHeaders(),
    },
    model: input.model,
    provider: CHATGPT_PROVIDER,
  };
}

/**
 * The client-identity headers the Codex CLI sends on every turn. The backend is
 * a Codex endpoint rather than a general API, so it is happier when the request
 * looks like the client it serves; `session_id` is per attempt, like a Codex
 * session.
 */
function codexClientHeaders(): Record<string, string> {
  return {
    originator: 'codex_cli_rs',
    session_id: randomUUID(),
    version: CODEX_CLIENT_VERSION,
  };
}
