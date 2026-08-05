import type { Logger } from '@repo/logging/logger';
import {
  LocalSandbox,
  LazySandbox,
  SshSandbox,
  type SandboxStore,
  sshSandboxFromEnv,
} from '@repo/sandbox';

/**
 * Union of every sandbox provider the tools can run against. All expose the
 * same surface (`run`, read/write file, `destroy`, `workDir`, `materialized`),
 * so callers can treat any of them identically.
 */
export type AnySandbox = LazySandbox | SshSandbox | LocalSandbox;

/** The env keys the provider selection reads. */
export interface SandboxEnv {
  SSH_SANDBOX_HOST?: string;
  SSH_SANDBOX_USER?: string;
  SSH_SANDBOX_PORT?: number;
  SSH_SANDBOX_PRIVATE_KEY?: string;
  SSH_SANDBOX_WORKDIR?: string;
  SSH_SANDBOX_BOOTSTRAP?: string;
  SANDBOX_WORKDIR?: string;
  E2B_API_KEY?: string;
}

export interface SandboxProviderInput {
  logger: Logger;
  /** Thread id, for E2B persistence across turns. */
  sessionId?: string;
  /** Store, for E2B persistence across turns. */
  store?: SandboxStore;
  /** Shell run once on materialization (e.g. install the slack helper). */
  bootstrapCommand?: string;
  /** Base env merged into every command (e.g. the Slack proxy vars). */
  baseEnv?: Record<string, string>;
  /** Real GitHub token, brokered via E2B egress rules (E2B only). */
  githubToken?: string;
}

/**
 * Build the sandbox the current deployment should use:
 *  1. SSH_SANDBOX_HOST set  -> run code over SSH on a box you own.
 *  2. E2B_API_KEY present    -> the E2B-backed per-thread sandbox.
 *  3. neither                -> run locally in this container (no E2B account
 *                                or card verification needed); files persist
 *                                naturally on the host filesystem.
 */
export async function createSandbox(
  env: SandboxEnv,
  input: SandboxProviderInput
): Promise<AnySandbox> {
  if (env.SSH_SANDBOX_HOST) {
    const sshOpts = await sshSandboxFromEnv(
      {
        SSH_SANDBOX_HOST: env.SSH_SANDBOX_HOST,
        SSH_SANDBOX_USER: env.SSH_SANDBOX_USER,
        SSH_SANDBOX_PORT: env.SSH_SANDBOX_PORT
          ? String(env.SSH_SANDBOX_PORT)
          : undefined,
        SSH_SANDBOX_PRIVATE_KEY: env.SSH_SANDBOX_PRIVATE_KEY,
        SSH_SANDBOX_WORKDIR: env.SSH_SANDBOX_WORKDIR,
        SSH_SANDBOX_BOOTSTRAP: env.SSH_SANDBOX_BOOTSTRAP,
      },
      input.logger
    );
    if (!sshOpts) {
      throw new Error('SSH_SANDBOX_HOST is set but SSH config could not load');
    }
    return new SshSandbox({
      ...sshOpts,
      bootstrapCommand: sshOpts.bootstrapCommand ?? input.bootstrapCommand,
    });
  }

  if (env.E2B_API_KEY) {
    return new LazySandbox({
      apiKey: env.E2B_API_KEY,
      bootstrapCommand: input.bootstrapCommand,
      env: input.baseEnv ?? {},
      githubToken: input.githubToken,
      logger: input.logger,
      sessionId: input.sessionId,
      store: input.store,
    });
  }

  return new LocalSandbox({
    workdir: env.SANDBOX_WORKDIR,
    bootstrapCommand: input.bootstrapCommand,
    baseEnv: input.baseEnv,
    logger: input.logger,
  });
}