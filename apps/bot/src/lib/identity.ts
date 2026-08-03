import { getIdentityProfiles, type IdentityProfile } from '@repo/db/queries';
import logger from '@/lib/logger';

// kyto's per-message-type presentation. The name is ALWAYS plain "kyto" — a
// profile only sets an optional icon (owner's call: no name suffixes, any
// icon). Applied where kyto posts a given kind of message (normal replies,
// cross-channel posts, reminder DMs). See the identity_profiles table + App
// Home config.

// 'subagent' is gone: a subagent posts no message of its own, so an icon has
// no surface there, and its card label is fixed ("kyto subagent" / "kyto
// subagent {name}") — nothing configurable decorates a name. A stale
// 'subagent' row in identity_profiles is simply never read.
export type IdentityType = 'normal' | 'reminder';

export const IDENTITY_TYPES: IdentityType[] = ['normal', 'reminder'];

const CACHE_TTL_MS = 30_000;

// `username` is never set by resolveIdentity (the name stays "kyto"); it exists
// for the owner-only per-post overrides in lib/post-identity.ts, which share
// this shape.
export interface ResolvedIdentity {
  iconEmoji?: string;
  iconUrl?: string;
  username?: string;
}

let cache: { at: number; profiles: IdentityProfile[] } | null = null;

/** Drop the cache so a fresh App Home change is applied immediately. */
export function resetIdentityCache(): void {
  cache = null;
}

async function loadProfiles(): Promise<IdentityProfile[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.profiles;
  }
  const profiles = await getIdentityProfiles().catch((error: unknown) => {
    logger.warn({ err: error }, '[identity] failed to load profiles');
    return [] as IdentityProfile[];
  });
  cache = { at: Date.now(), profiles };
  return profiles;
}

function iconFields(icon: string | null): {
  iconEmoji?: string;
  iconUrl?: string;
} {
  const trimmed = icon?.trim();
  if (!trimmed) {
    return {};
  }
  if (/^https?:\/\//.test(trimmed)) {
    return { iconUrl: trimmed };
  }
  // A Slack emoji code like `:robot_face:`. Unicode emoji can't be an
  // icon_emoji, so only pass through the `:name:` form.
  if (/^:[\w+-]+:$/.test(trimmed)) {
    return { iconEmoji: trimmed };
  }
  return {};
}

/** The icon override for a message type, or {} when unset. */
export async function resolveIdentity(
  type: IdentityType
): Promise<ResolvedIdentity> {
  const profiles = await loadProfiles();
  const profile = profiles.find((p) => p.messageType === type);
  if (!profile) {
    return {};
  }
  return iconFields(profile.icon);
}
