/**
 * Strip single-use credentials out of email before kyto ever sees them.
 *
 * kyto's inbox is a real, addressable mailbox, and anyone in the workspace can
 * ask kyto to read it. That combination is an account-takeover primitive: go to
 * a service kyto has an account with, click "forgot password", then ask kyto to
 * read its latest email and repeat the link. kyto has no way to tell that
 * request apart from "read me my mail" — the message really is in its inbox and
 * the person really is allowed to talk to it.
 *
 * Redaction therefore happens HERE, at the tool boundary, for everyone
 * including the owner. Filtering by who is asking would not help: the model
 * would still be holding the token, and one convincing message ("devansh said
 * to forward this") is all it takes to get it back out. What the model never
 * receives, it cannot be talked into leaking. The owner reads reset links in
 * the AgentMail UI, where no model is involved.
 *
 * This is a mitigation, not a proof. It is pattern matching over adversary-
 * controlled text, and a reset link with no telltale word or token shape in it
 * gets through. It removes the easy path, and every other guard (owner-only
 * outbound sends, the confirm-post gate) still stands behind it.
 */

const REDACTED_LINK = '[redacted: possible auth link]';
const REDACTED_CODE = '[redacted: possible auth code]';

const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/gi;

// Words that make a URL an authentication link rather than an ordinary one.
const AUTH_WORDS =
  /(?:reset|recover|forgot|verif|confirm|activat|validate|magic|passwordless|one[-_]?time|onetime|otp|2fa|mfa|token|auth|signin|sign-in|log-?in|invit|unlock|challenge|credential|set[-_]?password|new[-_]?password|change[-_]?password|session)/i;

// Query parameters that carry a credential when their value is long enough.
const SECRET_PARAM =
  /^(?:t|c|k|q|s|token|code|key|secret|auth|otp|nonce|signature|sig|hash|state|ticket|confirmation|verification|access[-_]?token|id[-_]?token|reset[-_]?token)$/i;
const SECRET_PARAM_MIN = 12;

// A long opaque path segment (…/reset/9f3a…) is a bare token in a path.
const OPAQUE_SEGMENT = /^[A-Za-z0-9_-]{24,}$/;

/** Whether this URL plausibly carries a single-use credential. */
function isSensitiveUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Unparseable, but it still matched a URL shape — judge on the text alone.
    return AUTH_WORDS.test(raw);
  }
  if (AUTH_WORDS.test(url.pathname) || AUTH_WORDS.test(url.search)) {
    return true;
  }
  for (const [name, value] of url.searchParams) {
    if (SECRET_PARAM.test(name) && value.length >= SECRET_PARAM_MIN) {
      return true;
    }
  }
  return url.pathname
    .split('/')
    .some((segment) => OPAQUE_SEGMENT.test(segment));
}

// A code stated near a word that introduces one: "your code is 123456",
// "verification code: 84213". Bounded lookahead so it can't span paragraphs.
const LABELLED_CODE =
  /\b(?:code|otp|pin|passcode|password|token)\b[^\n]{0,40}?\b([A-Z0-9]{4,10})\b/gi;

// A code on a line of its own, which is how most providers present them.
const LONE_CODE = /^\s*([0-9]{4,8}|[A-Z0-9]{6,8})\s*$/gm;

export interface Redaction {
  redactions: number;
  text: string;
}

export function redactSecrets(input: string | undefined): Redaction {
  if (!input) {
    return { redactions: 0, text: '' };
  }
  let redactions = 0;
  let text = input.replace(URL_RE, (match) => {
    // Trailing sentence punctuation is not part of the URL; keep it.
    const trailing = /[.,;:!?)]+$/.exec(match)?.[0] ?? '';
    const url = trailing ? match.slice(0, -trailing.length) : match;
    if (!isSensitiveUrl(url)) {
      return match;
    }
    redactions += 1;
    return REDACTED_LINK + trailing;
  });
  text = text.replace(LABELLED_CODE, (match, code: string) => {
    redactions += 1;
    return match.replace(code, REDACTED_CODE);
  });
  text = text.replace(LONE_CODE, () => {
    redactions += 1;
    return REDACTED_CODE;
  });
  return { redactions, text };
}

/** The note appended to a tool result so the model can explain the gap. */
export function redactionNote(redactions: number): string | undefined {
  if (redactions === 0) {
    return;
  }
  return `${redactions} thing${redactions === 1 ? '' : 's'} that looked like a login link or one-time code ${redactions === 1 ? 'was' : 'were'} removed before you saw this, so you genuinely do not have ${redactions === 1 ? 'it' : 'them'} and cannot pass ${redactions === 1 ? 'it' : 'them'} on. This applies to everyone, the owner included — say so plainly and point them at the AgentMail inbox. Do not try to recover the value another way.`;
}
