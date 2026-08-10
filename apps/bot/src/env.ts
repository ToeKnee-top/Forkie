import 'dotenv/config';
import { keys as ai } from '@repo/ai/keys';
import { keys as database } from '@repo/db/keys';
import { keys as logging } from '@repo/logging/keys';
import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const env = createEnv({
  extends: [ai(), database(), logging()],
  server: {
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),

    SLACK_BOT_TOKEN: z.string().min(1),
    SLACK_SIGNING_SECRET: z.string().min(1),
    SLACK_APP_TOKEN: z.string().min(1),
    // User OAuth token (xoxp-) used to post/edit AS the owner. Only ever applied
    // when the turn was triggered by OWNER_USER_ID; see the sendAsUser tool.
    SLACK_USER_TOKEN: z.string().optional(),
    // Slack user id allowed to act as themselves via SLACK_USER_TOKEN.
    OWNER_USER_ID: z.string().optional(),
    PORT: z.coerce.number().default(3000),
    OPT_IN_CHANNEL: z.string().optional(),

    // Static site hosting (see lib/sites). The host only ever serves prebuilt
    // static files from SITES_ROOT — it never executes site code. Building and
    // testing happen exclusively in the E2B sandbox.
    SITES_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    SITES_PORT: z.coerce.number().default(8080),
    // Serve HTTPS with a self-signed cert. Leave false when running behind a
    // TLS-terminating reverse proxy (e.g. Nest), which forwards plain HTTP to
    // the container — serving HTTPS there causes 502 Bad Gateway.
    SITES_TLS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    SITES_ROOT: z.string().default('/var/kytosites'),
    // Public host used to build the public site URL returned to the agent.
    // Sites are served at the host root, e.g. https://<host>/<name>/<page>/. The
    // URL is always https:// (Nest terminates TLS).
    SITES_PUBLIC_HOST: z.string().default('kyto.devansh.hackclub.app'),

    // Owner dashboard, mounted on the same host as the sites server at
    // /_dashboard (see lib/dashboard). This password is the ONLY thing standing
    // between the public internet and promoting a memory into everyone's system
    // prompt or granting GitHub write trust, so the whole dashboard stays off
    // unless it is set, and short passwords are rejected outright.
    DASHBOARD_PASSWORD: z.string().min(12).optional(),

    E2B_API_KEY: z.string().min(1).optional(),
    // Sandbox provider selection: SSH_SANDBOX_HOST => code runs over SSH on a
    // box you own; else E2B_API_KEY => the E2B-backed per-thread sandbox; else
    // run locally in this container (no E2B account/card needed). SANDBOX_WORKDIR
    // is the base dir for the local provider.
    SSH_SANDBOX_HOST: z.string().optional(),
    SSH_SANDBOX_USER: z.string().optional(),
    SSH_SANDBOX_PORT: z.coerce.number().optional(),
    SSH_SANDBOX_PRIVATE_KEY: z.string().optional(),
    SSH_SANDBOX_WORKDIR: z.string().optional(),
    SSH_SANDBOX_BOOTSTRAP: z.string().optional(),
    SANDBOX_WORKDIR: z.string().optional(),
    AGENTMAIL_API_KEY: z.string().min(1).optional(),
    // GitHub CLI token for the `gh` tool (injected per-call into the sandbox,
    // never persisted as a shell env var). Tool is registered only when set.
    GH_TOKEN: z.string().min(1).optional(),
    // The GitHub account that token belongs to — kyto's own identity there. Used
    // to tell the model that PRs/issues authored by it are kyto's own work, and
    // to decide which repos the ownership gate auto-claims.
    GH_LOGIN: z.string().min(1).default('kyto-agent'),
    // Replicate access via HackClub's proxy — a SEPARATE key from
    // HACKCLUB_API_KEY (Replicate is gated per-key there). Preferred TTS
    // backend; falls back to Gemini TTS when unset.
    HACKCLUB_REPLICATE_API_KEY: z.string().min(1).optional(),

    // Passphrase for encrypting users' own model API keys (BYOK) at rest. Needs
    // real entropy: it is stretched with scrypt into the AES-256-GCM key that
    // protects every stored key. Unset = the BYOK feature is off entirely (no
    // App Home section, no per-user routing) rather than storing keys in clear.
    BYOK_ENCRYPTION_KEY: z.string().min(32).optional(),

    LANGFUSE_BASEURL: z.url().optional(),
    LANGFUSE_PUBLIC_KEY: z.string().min(1).optional(),
    LANGFUSE_SECRET_KEY: z.string().min(1).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
