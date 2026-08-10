export interface RequestHints {
  botUserId?: string;
  channel?: {
    id?: string;
    name?: string;
  };
  customization?: { prompt: string; showUsageFooter?: boolean } | null;
  // forkie's own email address (AgentMail inbox), resolved once and cached — it
  // never changes, so it rides in every prompt without a per-turn lookup.
  email?: string;
  githubLogin?: string;
  // Every memory VISIBLE ON THIS TURN — the current person's own, plus the ones
  // the owner promoted to global. Titles only, so forkie knows what durable
  // knowledge exists and can fetch the full body when relevant.
  memories?: { title: string; createdBy?: string; isGlobal?: boolean }[];
  messageId?: string;
  // Name resolved live from the Slack account behind OWNER_USER_ID (real name
  // else display name). Lets the account, not a hardcoded string, name the owner.
  ownerName?: string;
  ownerUserId?: string;
  threadId: string;
  time: string;
  workspace?: string;
}
