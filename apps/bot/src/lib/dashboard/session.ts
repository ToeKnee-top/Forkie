import { randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '@/env';

// Sessions for the owner dashboard. In-memory on purpose: there is exactly one
// operator, a restart logging him out is not a problem, and it keeps a
// long-lived credential out of the database entirely.

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_NAME = 'kyto_dash';

// Login throttling. The dashboard sits on a public host behind ONE password, so
// an unbounded POST endpoint is an offline-speed guessing oracle. After
// MAX_ATTEMPTS failures the whole endpoint refuses for LOCKOUT_MS — there is
// only one legitimate user, so locking globally costs nothing and there is no
// per-IP bookkeeping to spoof around.
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

interface Session {
  /** Random per-session value every mutating form must echo back. */
  csrf: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();
let failedAttempts = 0;
let lockedUntil = 0;

/** Whether the dashboard is configured at all. No password, no dashboard. */
export function dashboardEnabled(): boolean {
  return Boolean(env.DASHBOARD_PASSWORD);
}

function sweep(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

/** Length-safe constant-time compare — timingSafeEqual throws on a mismatch. */
function secretsMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so a wrong LENGTH isn't faster than a wrong value.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export type LoginResult =
  | { ok: true; cookie: string }
  | { ok: false; reason: string };

export function login(password: string): LoginResult {
  const expected = env.DASHBOARD_PASSWORD;
  if (!expected) {
    return { ok: false, reason: 'The dashboard is not configured.' };
  }
  const now = Date.now();
  if (now < lockedUntil) {
    const minutes = Math.ceil((lockedUntil - now) / 60_000);
    return {
      ok: false,
      reason: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    };
  }
  if (!secretsMatch(password, expected)) {
    failedAttempts += 1;
    if (failedAttempts >= MAX_ATTEMPTS) {
      lockedUntil = now + LOCKOUT_MS;
      failedAttempts = 0;
    }
    return { ok: false, reason: 'Wrong password.' };
  }
  failedAttempts = 0;
  sweep();
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, {
    csrf: randomBytes(24).toString('base64url'),
    expiresAt: now + SESSION_TTL_MS,
  });
  return { cookie: sessionCookie(token), ok: true };
}

function sessionCookie(token: string): string {
  // Path-scoped so it never rides along on a request for a hosted site, and
  // SameSite=Strict so a link from anywhere else can't drive a form post.
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/_dashboard; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/_dashboard; Max-Age=0`;
}

function readCookie(request: Request): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) {
    return;
  }
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) {
      return rest.join('=');
    }
  }
  return;
}

/** The caller's live session, or null. Also the logout hook. */
export function currentSession(request: Request): Session | null {
  const token = readCookie(request);
  if (!token) {
    return null;
  }
  const session = sessions.get(token);
  if (!session) {
    return null;
  }
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function logout(request: Request): void {
  const token = readCookie(request);
  if (token) {
    sessions.delete(token);
  }
}

/** A form post is only honored if it carries this session's own CSRF token. */
export function csrfValid(session: Session, submitted: string | null): boolean {
  return Boolean(submitted) && secretsMatch(submitted ?? '', session.csrf);
}
