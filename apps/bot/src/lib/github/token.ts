import { env } from '@/env';
import logger from '@/lib/logger';

/**
 * Is kyto's GitHub token actually usable?
 *
 * This exists because of how the token is brokered. `githubNetwork` installs an
 * E2B egress rule that rewrites `Authorization` on EVERY outbound request to
 * github.com, so the sandbox can act as the token's identity without ever
 * holding it. The rule is unconditional, which means a DEAD token doesn't just
 * break authenticated work — it breaks anonymous work too. `git clone` of a
 * PUBLIC repo fails with "Invalid username or token", because a credential
 * GitHub rejects is attached before GitHub ever gets to consider the request
 * anonymous. A whole turn was spent concluding hackclub/stardance must be
 * private when it is public and a plain unauthenticated clone would have worked.
 *
 * So: ask GitHub once whether the token is any good, and only broker it if it
 * is. A rejected token is left out of the egress rules entirely, which costs
 * nothing that wasn't already broken (authenticated work fails either way) and
 * buys back every public read.
 *
 * The verdict is re-checked periodically so rotating GH_TOKEN doesn't need a
 * restart — though a given thread still only picks up the change on its NEXT
 * fresh sandbox, since egress rules are fixed at sandbox-create time.
 */

// How long a verdict is trusted. Short enough that a rotated token starts
// working without a restart, long enough that this is not a per-turn API call.
const VERDICT_TTL_MS = 15 * 60 * 1000;

// GitHub answers a bad credential with 401, and a token whose scopes were
// stripped (or that an org blocked) with 403. Either way it cannot be brokered.
const REJECTED = new Set([401, 403]);

const CHECK_TIMEOUT_MS = 10_000;

interface Verdict {
  checkedAt: number;
  live: boolean;
}

let verdict: Verdict | undefined;
let inFlight: Promise<Verdict> | undefined;

async function askGithub(token: string): Promise<Verdict> {
  const checkedAt = Date.now();
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (REJECTED.has(response.status)) {
      logger.warn(
        { status: response.status },
        '[github] token was rejected; it will NOT be brokered into sandboxes, so public repos stay readable anonymously'
      );
      return { checkedAt, live: false };
    }
    if (!response.ok) {
      // A 5xx or a rate limit says nothing about the token. Keep whatever we
      // believed before rather than downgrading on a GitHub blip.
      logger.warn(
        { status: response.status },
        '[github] token check was inconclusive; keeping the previous verdict'
      );
      return { checkedAt, live: verdict?.live ?? true };
    }
    return { checkedAt, live: true };
  } catch (error) {
    // Same reasoning as a 5xx: an unreachable api.github.com is not evidence.
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      '[github] token check failed to reach GitHub; keeping the previous verdict'
    );
    return { checkedAt, live: verdict?.live ?? true };
  }
}

/**
 * The GitHub token to broker into a sandbox's egress rules, or `undefined` when
 * there is none configured or the configured one is rejected. Passing
 * `undefined` to `LazySandbox` leaves the github.com rewrite rule off, so git
 * and `gh` reach GitHub unauthenticated — which is what makes public reads work.
 */
export async function brokerableGithubToken(): Promise<string | undefined> {
  const token = env.GH_TOKEN;
  if (!token) {
    return;
  }
  const fresh = verdict && Date.now() - verdict.checkedAt < VERDICT_TTL_MS;
  if (fresh) {
    return verdict?.live ? token : undefined;
  }
  // Collapse concurrent checks (several turns can start at once) into one call.
  inFlight ??= askGithub(token).finally(() => {
    inFlight = undefined;
  });
  verdict = await inFlight;
  return verdict.live ? token : undefined;
}

/**
 * Whether GitHub work can be expected to succeed at all, for tools that want to
 * refuse up front rather than let a command fail confusingly.
 */
export async function githubTokenIsLive(): Promise<boolean> {
  return (await brokerableGithubToken()) !== undefined;
}
