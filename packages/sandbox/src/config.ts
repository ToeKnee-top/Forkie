const MINUTE_MS = 60 * 1000;

export const sandboxConfig = {
  // E2B template name is the deployed external resource id, not branding —
  // keep it as the actual published template ('gorkie-sandbox'). Rebuild and
  // republish via `bun run build:template` if you want it renamed to kyto.
  template: 'gorkie-sandbox:3.0',
  workdir: '/home/user',
  timeoutMs: 10 * MINUTE_MS,
  executionTimeoutMs: 20 * MINUTE_MS,
};
