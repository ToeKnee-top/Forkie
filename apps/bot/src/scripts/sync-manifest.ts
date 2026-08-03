import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

/**
 * Push slack-manifest.json to the Slack app configuration via the
 * apps.manifest.update API, so editing the manifest in this repo updates the
 * live app config (scopes, events, etc.) in one command.
 *
 * Requires a Slack **app configuration token** (NOT the bot/user token). Create
 * one at https://api.slack.com/apps -> "Your App Configuration Tokens". They are
 * short-lived (~12h); pass a refresh token to auto-rotate before updating.
 *
 * Env:
 *   SLACK_APP_ID                  the target app id (Axxxxxxxx)
 *   SLACK_CONFIG_ACCESS_TOKEN     configuration access token (xoxe.xoxp-...)
 *   SLACK_CONFIG_REFRESH_TOKEN    optional; if set, the access token is rotated
 *
 * Usage: bun run sync:manifest
 */

const MANIFEST_PATH = resolve(
  fileURLToPath(new URL('../../../../slack-manifest.json', import.meta.url))
);

interface SlackResponse {
  error?: string;
  ok: boolean;
  permissions_updated?: boolean;
  refresh_token?: string;
  token?: string;
}

async function slackPost(
  method: string,
  body: Record<string, string>
): Promise<SlackResponse> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    body: new URLSearchParams(body),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });
  return (await response.json()) as SlackResponse;
}

async function rotateToken(refreshToken: string): Promise<string> {
  const result = await slackPost('tooling.tokens.rotate', {
    refresh_token: refreshToken,
  });
  if (!(result.ok && result.token)) {
    throw new Error(`Failed to rotate config token: ${result.error}`);
  }
  process.stdout.write(
    `Rotated config token. New refresh token (save it):\n${result.refresh_token}\n`
  );
  return result.token;
}

async function main(): Promise<void> {
  const appId = process.env.SLACK_APP_ID;
  const refreshToken = process.env.SLACK_CONFIG_REFRESH_TOKEN;
  let accessToken = process.env.SLACK_CONFIG_ACCESS_TOKEN;

  if (!appId) {
    throw new Error('SLACK_APP_ID is required.');
  }
  if (refreshToken) {
    accessToken = await rotateToken(refreshToken);
  }
  if (!accessToken) {
    throw new Error(
      'SLACK_CONFIG_ACCESS_TOKEN (or SLACK_CONFIG_REFRESH_TOKEN) is required.'
    );
  }

  const manifest = await readFile(MANIFEST_PATH, 'utf8');
  // Validate it's well-formed JSON before sending.
  JSON.parse(manifest);

  const result = await slackPost('apps.manifest.update', {
    app_id: appId,
    manifest,
    token: accessToken,
  });
  if (!result.ok) {
    throw new Error(`apps.manifest.update failed: ${result.error}`);
  }
  process.stdout.write(
    `Updated app ${appId} from slack-manifest.json.${
      result.permissions_updated
        ? ' Scopes changed — reinstall the app to grant them.'
        : ''
    }\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
