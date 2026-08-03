import { AgentMailClient } from 'agentmail';
import { env } from '@/env';
import logger from '@/lib/logger';

// kyto's own email address never changes for the life of the inbox, so there is
// no reason to pay an AgentMail round trip for it on every turn. Resolve it ONCE
// per process and cache the promise forever. A failure caches `null` and is
// retried on the next call (a transient AgentMail outage shouldn't permanently
// blank the address), but a success is pinned.
//
// The AgentMail inbox id IS the address (e.g. `kyto@agentmail.to`), so listing
// the first inbox gives us both. Surfaced in the context prompt so kyto knows
// its own address without having to call checkInbox first (the owner watched it
// look itself up mid-task).
let cached: string | null | undefined;
let inFlight: Promise<string | null> | undefined;

async function fetchAddress(): Promise<string | null> {
  if (!env.AGENTMAIL_API_KEY) {
    return null;
  }
  try {
    const client = new AgentMailClient({ apiKey: env.AGENTMAIL_API_KEY });
    const { inboxes } = await client.inboxes.list();
    return inboxes.at(0)?.inboxId ?? null;
  } catch (error) {
    logger.warn({ err: error }, '[email] failed to resolve kyto inbox address');
    return null;
  }
}

export async function resolveKytoEmail(): Promise<string | undefined> {
  if (cached !== undefined && cached !== null) {
    return cached;
  }
  if (!inFlight) {
    inFlight = fetchAddress();
  }
  const address = await inFlight;
  inFlight = undefined;
  cached = address;
  return address ?? undefined;
}
