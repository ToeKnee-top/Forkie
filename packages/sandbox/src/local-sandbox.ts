import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from '@repo/logging/logger';

/**
 * A local implementation of the same surface `LazySandbox` offers to the
 * tools, so QuackX can run its code-execution directly on the host it already
 * runs on (e.g. its own Hack Club Nest container) instead of E2B — no card
 * verification, no per-second billing, no third-party sandbox, no extra box.
 *
 * Why this exists over the E2B default: the E2B-backed sandbox needs a $5 card
 * verification (credited back as usage) that a lot of student deployments
 * don't want to do. If the bot already lives in an always-on, persistent
 * container, the sandbox can simply BE that container: commands run via a
 * child process and files live on the same filesystem.
 *
 * SECURITY (important): this runs untrusted code in the SAME container as the
 * bot, so it does NOT inherit the bot's `process.env`. A scrubbed environment
 * (PATH/HOME/LANG plus only what a call explicitly passes in `env`) is built
 * for every spawned process, so code a Slack message can make us run never
 * sees SLACK_BOT_TOKEN, the AI keys, etc. That mirrors how E2B keeps the
 * sandbox env separate. You are still trusting the container as a whole, so
 * only run this on a box you own. The GitHub egress-token brokering E2B uses
 * (gh-as-kyto identity without giving the sandbox the token) cannot be
 * reproduced locally, so GitHub-token auth inside the sandbox is lost.
 *
 * Persistence is free: unlike E2B there is no sandbox id to pause/remember —
 * the filesystem is inherently there every turn. `destroy()` is therefore a
 * no-op.
 */

export interface LocalSandboxOptions {
  /** Base directory commands run in by default; created on demand. */
  workdir?: string;
  /** Shell command run once on first materialization (install helpers). */
  bootstrapCommand?: string;
  /** Per-command execution timeout, ms. Default 20 minutes. */
  timeoutMs?: number;
  /** Extra base env merged into every spawned process (beyond scrubbed core). */
  baseEnv?: Record<string, string>;
  logger?: Logger;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_WORKDIR = '/home/user';
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

export class LocalSandbox {
  readonly workDir: string;

  private readonly cfg: Required<
    Pick<LocalSandboxOptions, 'timeoutMs'>
  > &
    LocalSandboxOptions;
  private readonly logger: Logger | undefined;
  private initialized = false;
  private initializing: Promise<void> | null = null;

  constructor(options: LocalSandboxOptions) {
    this.cfg = {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...options,
    };
    this.workDir = options.workdir ?? DEFAULT_WORKDIR;
    this.logger = options.logger;
  }

  get materialized(): boolean {
    return this.initialized;
  }

  /**
   * A scrubbed environment for any process we spawn. Deliberately does NOT
   * spread `process.env`, so the bot's secrets never leak to sandbox code —
   * only a minimal core plus whatever the caller passes in `env`.
   */
  private cleanEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: this.workDir,
      LANG: 'C.UTF-8',
      ...this.cfg.baseEnv,
      ...env,
    };
  }

  private async ensure(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initializing) {
      return this.initializing;
    }
    this.initializing = (async () => {
      await mkdir(this.workDir, { recursive: true });
      if (this.cfg.bootstrapCommand) {
        await this.raw(this.cfg.bootstrapCommand, {
          cwd: this.workDir,
          timeoutMs: 60_000,
        });
      }
      this.initialized = true;
    })();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  private async raw(
    script: string,
    opts: {
      cwd: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    }
  ): Promise<CommandResult> {
    opts.signal?.throwIfAborted();
    const child = spawn('bash', ['--noprofile', '--norc', '-c', script], {
      cwd: opts.cwd,
      env: this.cleanEnv(opts.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    return await new Promise<CommandResult>((resolve, reject) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout!.on('data', (c: Buffer) => out.push(c));
      child.stderr!.on('data', (c: Buffer) => err.push(c));

      let timer: NodeJS.Timeout | undefined;
      let settled = false;

      const finish = (
        failure: Error | null,
        code?: number,
        signal?: string | null
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        opts.signal?.removeEventListener('abort', onAbort);
        if (failure) {
          reject(failure);
          return;
        }
        resolve({
          exitCode: signal ? -1 : (code ?? -1),
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
        });
      };

      const onAbort = () => {
        child.kill('SIGKILL');
        finish(new Error('command aborted'));
      };

      child.on('error', (e) => finish(e));
      child.on('close', (code, signal) => finish(null, code ?? 1, signal));

      timer = setTimeout(() => {
        this.logger?.warn(
          { cmd: script.slice(0, 120), timeoutMs: opts.timeoutMs ?? this.cfg.timeoutMs },
          '[local-sandbox] command timed out; killed'
        );
        child.kill('SIGKILL');
        finish(null, 124);
      }, opts.timeoutMs ?? this.cfg.timeoutMs);

      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
        } else {
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
      }
    });
  }

  async run({
    abortSignal,
    command,
    env,
    workingDirectory,
  }: {
    abortSignal?: AbortSignal;
    command: string;
    env?: Record<string, string>;
    workingDirectory?: string;
  }): Promise<CommandResult> {
    await this.ensure();
    return await this.raw(command, {
      cwd: workingDirectory ?? this.workDir,
      env,
      signal: abortSignal,
    });
  }

  async readBinaryFile({ path }: { path: string }): Promise<Uint8Array | null> {
    await this.ensure();
    return await readFile(path)
      .then((b) => new Uint8Array(b))
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return null;
        }
        throw error;
      });
  }

  async readTextFile({ path }: { path: string }): Promise<string | null> {
    const bytes = await this.readBinaryFile({ path });
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  async writeBinaryFile({
    content,
    path,
  }: {
    content: Uint8Array;
    path: string;
  }): Promise<void> {
    await this.ensure();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content as unknown as Uint8Array);
  }

  async writeTextFile({
    content,
    path,
  }: {
    content: string;
    path: string;
  }): Promise<void> {
    await this.writeBinaryFile({
      content: new TextEncoder().encode(content),
      path,
    });
  }

  /** No-op: files persist on the host filesystem; nothing to pause/kill. */
  async destroy(): Promise<void> {}

  /** Alias for callers that expect a symmetric name. */
  async kill(): Promise<void> {
    await this.destroy();
  }

  /** No-op: local processes have no shared E2B timeout. */
  async setTimeout(_ms: number): Promise<void> {}

  /** No-op: filesystem is inherently resumable. */
  async pause(): Promise<boolean> {
    return true;
  }
}

/** True when the local sandbox should be used (no E2B key, no SSH host). */
export function localSandboxConfigured(
  env: Record<string, string | undefined>
): boolean {
  return !env.E2B_API_KEY && !env.SSH_SANDBOX_HOST;
}

/** Build a LocalSandbox from env, when it is the selected provider. */
export function localSandboxFromEnv(
  env: Record<string, string | undefined>,
  opts: { bootstrapCommand?: string; baseEnv?: Record<string, string>; logger?: Logger }
): LocalSandbox | undefined {
  if (!localSandboxConfigured(env)) {
    return undefined;
  }
  return new LocalSandbox({
    workdir: env.SANDBOX_WORKDIR,
    bootstrapCommand: opts.bootstrapCommand,
    baseEnv: opts.baseEnv,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
}
