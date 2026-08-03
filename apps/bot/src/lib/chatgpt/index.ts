import {
  buildChatgptAuthUrl,
  CHATGPT_OAUTH,
  CHATGPT_PROVIDER,
  CODEX_CLIENT_VERSION,
  chatgptAttempt,
  generateOauthState,
  generatePkce,
  type ModelAttempt,
} from '@repo/ai';
import {
  getChatgptAccount,
  getChatgptAccountSecret,
  setChatgptQuotaReset,
  setChatgptValidation,
  updateChatgptModel,
  updateChatgptTokens,
  upsertChatgptAccount,
} from '@repo/db/queries';
import {
  byokConfigured,
  decryptSecret,
  encryptSecret,
} from '@/lib/byok/crypto';
import logger from '@/lib/logger';
import { deepErrorText, errorStatus } from '@/lib/utils/error';

// The token blob stored (encrypted) for a linked account. Only this module ever
// sees it in the clear.
interface StoredTokens {
  accessToken: string;
  accountId?: string;
  // Epoch ms when the access token expires; we refresh a bit before this.
  expiresAt: number;
  idToken?: string;
  refreshToken: string;
}

// A link attempt in flight: the PKCE verifier + state, kept between showing the
// user the authorize URL and them pasting the callback back. In-memory and
// short-lived — a link that doesn't survive a restart just means the user clicks
// "Sign in" again (same philosophy as harness/kv.ts and the confirm-post store).
interface PendingLink {
  expiresAt: number;
  state: string;
  verifier: string;
}

const LINK_TTL_MS = 10 * 60 * 1000;
// Refresh the access token when it's within this window of expiring.
const REFRESH_SKEW_MS = 60 * 1000;
const pendingLinks = new Map<string, PendingLink>();

function sweepLinks(): void {
  const now = Date.now();
  for (const [userId, link] of pendingLinks) {
    if (link.expiresAt <= now) {
      pendingLinks.delete(userId);
    }
  }
}

/** Is the "Sign in with ChatGPT" feature usable? Gated on the same key as BYOK. */
export function chatgptConfigured(): boolean {
  return byokConfigured();
}

/**
 * Begin linking: mint PKCE + state, stash them for this user, and return the
 * authorize URL to show them. They sign in, land on the dead localhost callback,
 * and paste that URL back (see completeChatgptLink).
 */
export function startChatgptLink(userId: string): string {
  sweepLinks();
  const pkce = generatePkce();
  const state = generateOauthState();
  pendingLinks.set(userId, {
    expiresAt: Date.now() + LINK_TTL_MS,
    state,
    verifier: pkce.verifier,
  });
  return buildChatgptAuthUrl({ codeChallenge: pkce.challenge, state });
}

/** Pull the `code` (and `state`) out of a pasted callback URL or a bare code. */
function parseCallback(pasted: string): { code?: string; state?: string } {
  const trimmed = pasted.trim();
  try {
    const url = new URL(trimmed);
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    };
  } catch {
    // Not a URL — treat the whole thing as the raw code (no state to verify).
    return { code: trimmed || undefined };
  }
}

// Decode a JWT payload (no signature check — we only read display claims from a
// token we just received over TLS from the token endpoint).
function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split('.');
  if (parts.length < 2) {
    return;
  }
  try {
    return JSON.parse(
      Buffer.from(parts[1] as string, 'base64url').toString('utf8')
    ) as Record<string, unknown>;
  } catch {
    return;
  }
}

// The ChatGPT account id + email live on namespaced claims in the id_token.
function claimsFromIdToken(idToken: string | undefined): {
  accountId?: string;
  label: string;
} {
  const payload = idToken ? decodeJwtPayload(idToken) : undefined;
  if (!payload) {
    return { label: 'ChatGPT account' };
  }
  const auth = payload['https://api.openai.com/auth'] as
    | Record<string, unknown>
    | undefined;
  const accountId =
    (typeof auth?.chatgpt_account_id === 'string'
      ? auth.chatgpt_account_id
      : undefined) ??
    (typeof payload.chatgpt_account_id === 'string'
      ? payload.chatgpt_account_id
      : undefined);
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  return { accountId, label: email ?? 'ChatGPT account' };
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  id_token?: string;
  refresh_token?: string;
}

const DEFAULT_EXPIRES_IN = 3600;

async function requestTokens(
  body: Record<string, string>
): Promise<TokenResponse> {
  const response = await fetch(CHATGPT_OAUTH.tokenUrl, {
    body: new URLSearchParams(body).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST',
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(
      `token endpoint ${response.status}: ${detail.slice(0, 200)}`
    );
    (error as { status?: number }).status = response.status;
    throw error;
  }
  return (await response.json()) as TokenResponse;
}

const TOKEN_TIMEOUT_MS = 20_000;

/**
 * Finish linking: verify state, exchange the authorization code (with the stored
 * PKCE verifier) for tokens, and store them encrypted. Returns a label to show
 * the user, or an error message. The default model is chosen conservatively; the
 * user can change it from App Home.
 */
export async function completeChatgptLink(input: {
  model: string;
  pasted: string;
  userId: string;
}): Promise<{ error?: string; label?: string; model?: string; ok: boolean }> {
  if (!chatgptConfigured()) {
    return { error: 'Sign in with ChatGPT is not enabled.', ok: false };
  }
  const pending = pendingLinks.get(input.userId);
  if (!pending || pending.expiresAt <= Date.now()) {
    pendingLinks.delete(input.userId);
    return {
      error: 'This sign-in expired. Click "Sign in with ChatGPT" again.',
      ok: false,
    };
  }
  const { code, state } = parseCallback(input.pasted);
  if (!code) {
    return {
      error:
        'Could not find a code in what you pasted. Paste the full URL you were redirected to.',
      ok: false,
    };
  }
  if (state && state !== pending.state) {
    return { error: 'Sign-in state did not match. Try again.', ok: false };
  }

  let tokens: TokenResponse;
  try {
    tokens = await requestTokens({
      client_id: CHATGPT_OAUTH.clientId,
      code,
      code_verifier: pending.verifier,
      grant_type: 'authorization_code',
      redirect_uri: CHATGPT_OAUTH.redirectUri,
    });
  } catch (error) {
    logger.warn(
      { err: deepErrorText(error), userId: input.userId },
      '[chatgpt] token exchange failed'
    );
    return {
      error: `Sign-in failed: ${deepErrorText(error).slice(0, 200)}`,
      ok: false,
    };
  }
  pendingLinks.delete(input.userId);

  if (!(tokens.access_token && tokens.refresh_token)) {
    return {
      error: 'The token response was missing tokens. Try again.',
      ok: false,
    };
  }
  const { accountId, label } = claimsFromIdToken(tokens.id_token);
  const stored: StoredTokens = {
    accessToken: tokens.access_token,
    ...(accountId ? { accountId } : {}),
    expiresAt: Date.now() + (tokens.expires_in ?? DEFAULT_EXPIRES_IN) * 1000,
    ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
    refreshToken: tokens.refresh_token,
  };
  try {
    await upsertChatgptAccount({
      accountLabel: label,
      encryptedTokens: encryptSecret(JSON.stringify(stored)),
      model: input.model,
      userId: input.userId,
    });
  } catch (error) {
    logger.warn(
      { err: deepErrorText(error), userId: input.userId },
      '[chatgpt] could not store linked account'
    );
    return {
      error: 'Could not save your ChatGPT account. Try again.',
      ok: false,
    };
  }
  // The link modal can only seed a guessed default model (no token yet), which
  // may not be one the account can actually use. Now that the account is stored
  // and its token works, fetch the real catalog and correct the model if needed
  // so the first turn doesn't fail on an unavailable model. Best-effort.
  const available = await listChatgptModels(input.userId).catch(() => []);
  const chosen = pickDefaultModel(input.model, available);
  if (chosen && chosen !== input.model) {
    await updateChatgptModel({ model: chosen, userId: input.userId }).catch(
      () => undefined
    );
  }
  return { label, model: chosen ?? input.model, ok: true };
}

// Keep the user's requested model if the account actually offers it; otherwise
// pick a sensible one from the catalog (prefer a non-"mini" model, then the
// highest slug). Returns undefined to leave the requested model untouched when
// the catalog couldn't be read.
function pickDefaultModel(
  requested: string,
  available: string[]
): string | undefined {
  if (available.length === 0 || available.includes(requested)) {
    return;
  }
  const full = available.filter((slug) => !slug.includes('mini'));
  const pool = full.length > 0 ? full : available;
  return pool.at(-1);
}

// Load, decrypt, and (if needed) refresh the tokens for a user. Persists a
// refreshed token blob. Returns undefined if there's no account or it can't be
// read/refreshed.
async function loadFreshTokens(
  userId: string
): Promise<StoredTokens | undefined> {
  const row = await getChatgptAccountSecret(userId).catch(() => undefined);
  if (!row) {
    return;
  }
  let stored: StoredTokens;
  try {
    stored = JSON.parse(decryptSecret(row.encryptedTokens)) as StoredTokens;
  } catch (error) {
    logger.warn(
      { err: deepErrorText(error), userId },
      '[chatgpt] could not decrypt stored tokens'
    );
    await setChatgptValidation({
      message: 'Stored login could not be read. Sign in again.',
      status: 'invalid',
      userId,
    }).catch(() => undefined);
    return;
  }
  if (stored.expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return stored;
  }
  // Access token expired (or about to): refresh it.
  try {
    const refreshed = await requestTokens({
      client_id: CHATGPT_OAUTH.clientId,
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
      scope: CHATGPT_OAUTH.scope,
    });
    if (!refreshed.access_token) {
      throw new Error('refresh returned no access_token');
    }
    const next: StoredTokens = {
      accessToken: refreshed.access_token,
      ...(stored.accountId ? { accountId: stored.accountId } : {}),
      expiresAt:
        Date.now() + (refreshed.expires_in ?? DEFAULT_EXPIRES_IN) * 1000,
      ...(refreshed.id_token ? { idToken: refreshed.id_token } : {}),
      // OpenAI rotates the refresh token on some responses; keep the new one.
      refreshToken: refreshed.refresh_token ?? stored.refreshToken,
    };
    await updateChatgptTokens({
      encryptedTokens: encryptSecret(JSON.stringify(next)),
      userId,
    }).catch(() => undefined);
    return next;
  } catch (error) {
    const status = errorStatus(error);
    logger.warn(
      { err: deepErrorText(error), status, userId },
      '[chatgpt] token refresh failed'
    );
    // Only a hard rejection means the login is dead; a transient failure leaves
    // it alone (the next turn retries).
    if (status && (status === 400 || status === 401 || status === 403)) {
      await setChatgptValidation({
        message: 'Your ChatGPT login expired. Sign in again.',
        status: 'invalid',
        userId,
      }).catch(() => undefined);
    }
    return;
  }
}

// The Codex model catalog: GET /models?client_version=<v> returns
// { models: [{ slug, visibility, supported_in_api, ... }] } — NOT the OpenAI
// /v1/models { data: [{ id }] } shape. Model id = slug. This is the account-aware
// list the user's local `npx openai-oauth`/Codex command shows.
interface CodexModelsResponse {
  models?: Array<{
    slug?: unknown;
    supported_in_api?: unknown;
    visibility?: unknown;
  }>;
}

// The catalog endpoint wants a client version (shared with the turn headers, so
// there is one value to bump). It only gates which models come back; a slightly
// stale value still lists the account's models.
const MODELS_TIMEOUT_MS = 15_000;

// The catalog marks each model's visibility; only surface usable ones.
function isPublicCodexModel(model: {
  supported_in_api?: unknown;
  visibility?: unknown;
}): boolean {
  return (
    model.supported_in_api !== false &&
    (model.visibility === undefined || model.visibility === 'list')
  );
}

/**
 * List the model slugs available to the user's linked account, from the
 * account-aware Codex model catalog (fresh token). Returns [] if there's no
 * account, the token can't be refreshed, or the call fails — the App Home model
 * picker then falls back to a free-text field.
 */
export async function listChatgptModels(userId: string): Promise<string[]> {
  const tokens = await loadFreshTokens(userId);
  if (!tokens) {
    return [];
  }
  try {
    const response = await fetch(
      `${CHATGPT_OAUTH.apiBaseUrl}/models?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`,
      {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          ...(tokens.accountId
            ? { 'chatgpt-account-id': tokens.accountId }
            : {}),
        },
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      }
    );
    if (!response.ok) {
      return [];
    }
    const body = (await response.json()) as CodexModelsResponse;
    const slugs = (body.models ?? [])
      .filter(isPublicCodexModel)
      .map((model) => model.slug)
      .filter((slug): slug is string => typeof slug === 'string');
    return [...new Set(slugs)].sort();
  } catch (error) {
    logger.warn(
      { err: deepErrorText(error), userId },
      '[chatgpt] could not list account models'
    );
    return [];
  }
}

/** How a linked ChatGPT account participates in a user's turn routing. */
export interface ChatgptRouting {
  attempt: ModelAttempt;
  chatgptFirst: boolean;
  serviceFallback: boolean;
}

/**
 * Resolve the acting user's linked ChatGPT account into a routable attempt
 * (refreshing the token first), plus their ordering and fallback preferences.
 * Undefined when there's no usable account.
 */
export async function resolveChatgptRouting(
  userId: string
): Promise<ChatgptRouting | undefined> {
  if (!chatgptConfigured()) {
    return;
  }
  const row = await getChatgptAccount(userId).catch(() => undefined);
  if (!row) {
    return;
  }
  // The plan's quota is spent and we know when it comes back. Skip the account
  // entirely until then: it is the FIRST attempt of every turn by default, so a
  // free plan whose window resets in weeks would otherwise prepend a guaranteed
  // 429 (plus the SDK's own retries of it) to every single fallback walk.
  if (row.quotaResetsAt && row.quotaResetsAt.getTime() > Date.now()) {
    logger.info(
      { resetsAt: row.quotaResetsAt.toISOString(), userId },
      '[chatgpt] skipping account until its plan quota resets'
    );
    return;
  }
  const tokens = await loadFreshTokens(userId);
  if (!tokens) {
    return;
  }
  const attempt = chatgptAttempt({
    accessToken: tokens.accessToken,
    accountId: tokens.accountId,
    model: row.model,
  });
  if (!attempt) {
    return;
  }
  return {
    attempt,
    chatgptFirst: row.chatgptFirst,
    serviceFallback: row.serviceFallback,
  };
}

const REJECTION_MAX_LENGTH = 200;

const TOO_MANY_REQUESTS = 429;

// A quota 429 from the ChatGPT backend carries the exact reset time, e.g.
// {"error":{"type":"usage_limit_reached","message":"The usage limit has been
// reached","plan_type":"free","resets_at":1787463079,"resets_in_seconds":2498975}}
// — epoch SECONDS. `resets_in_seconds` is the same information relative to now,
// used as a fallback since only one of the two is guaranteed to be present.
const RESETS_AT = /"resets_at"\s*:\s*(\d+)/;
const RESETS_IN_SECONDS = /"resets_in_seconds"\s*:\s*(\d+)/;
const USAGE_LIMIT = /usage_limit_reached|usage limit has been reached/i;

// Don't trust an absurd window: a bad parse that parked the account for years
// would look exactly like the account silently never being used again. A month
// covers the longest real reset seen (a free plan's ~29 days).
const MAX_QUOTA_PARK_MS = 31 * 24 * 60 * 60 * 1000;
// A quota 429 with no parseable reset still shouldn't be retried immediately.
const DEFAULT_QUOTA_PARK_MS = 60 * 60 * 1000;

/**
 * When a usage-limit 429 says the account's quota comes back, or undefined when
 * the error isn't a quota rejection at all.
 */
function quotaResetFrom(error: unknown): Date | undefined {
  const text = deepErrorText(error);
  if (!USAGE_LIMIT.test(text)) {
    return;
  }
  const absolute = RESETS_AT.exec(text);
  const relative = RESETS_IN_SECONDS.exec(text);
  const candidate = (() => {
    if (absolute?.[1]) {
      return Number(absolute[1]) * 1000;
    }
    if (relative?.[1]) {
      return Date.now() + Number(relative[1]) * 1000;
    }
    return Date.now() + DEFAULT_QUOTA_PARK_MS;
  })();
  const clamped = Math.min(candidate, Date.now() + MAX_QUOTA_PARK_MS);
  // A reset already in the past means the quota is available now — nothing to do.
  return clamped > Date.now() ? new Date(clamped) : undefined;
}

/**
 * Record what a ChatGPT attempt's outcome says about the linked account, so the
 * user sees it in App Home. Mirrors recordByokOutcome: only a hard auth
 * rejection marks it invalid.
 */
export async function recordChatgptOutcome(input: {
  attempt: ModelAttempt;
  error?: unknown;
  userId: string;
}): Promise<void> {
  if (input.attempt.provider !== CHATGPT_PROVIDER) {
    return;
  }
  if (!input.error) {
    await setChatgptValidation({ status: 'valid', userId: input.userId }).catch(
      () => undefined
    );
    // A turn that completed proves the quota is back, whatever we recorded before.
    await setChatgptQuotaReset({
      resetsAt: null,
      userId: input.userId,
    }).catch(() => undefined);
    return;
  }
  const status = errorStatus(input.error);
  // A spent plan quota is not a broken login — park the account until the reset
  // the 429 named instead of marking it invalid or retrying it next turn.
  if (status === TOO_MANY_REQUESTS) {
    const resetsAt = quotaResetFrom(input.error);
    if (resetsAt) {
      logger.warn(
        { resetsAt: resetsAt.toISOString(), userId: input.userId },
        '[chatgpt] plan quota exhausted; parking the account until it resets'
      );
      await setChatgptQuotaReset({ resetsAt, userId: input.userId }).catch(
        () => undefined
      );
    }
    return;
  }
  if (!(status && (status === 401 || status === 402 || status === 403))) {
    return;
  }
  await setChatgptValidation({
    message: `${status}: ${deepErrorText(input.error).slice(0, REJECTION_MAX_LENGTH) || 'account rejected'}`,
    status: 'invalid',
    userId: input.userId,
  }).catch(() => undefined);
}
