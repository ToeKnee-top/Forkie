import { randomBytes } from 'node:crypto';
import { Client, type ConnectConfig, type ExecOptions } from 'ssh2';
import type { Logger } from '@repo/logging/logger';

/**
 * An SSH-backed implementation of the same surface `LazySandbox` offers to the
 * tools, so QuackX can run its code-execution on a self-hosted box (e.g. a Hack
 * Club Nest container) instead of E2B — no card verification, no per-second
 * billing, no third-party sandbox.
 *
 * Security model: the bot process (which holds the real secrets) connects OUT
 * over SSH to the sandbox host, and only ever ships it command strings and file
 * bytes. The sandbox never receives the bot's env secrets, so code from a Slack
 * message cannot read the token. The one thing that changes vs E2B is that the
 * sandbox and the bot are no longer cryptographically isolated by a provider —
 * you are trusting the box you point this at, so only run it against a box you
 * own (your Nest container), ideally one whose filesystem holds nothing else
 * sensitive.
 *
 * Persistence is free: on E2B a "remembered sandbox id" is how a thread's files
 * survive between turns. A single, long-lived host you reconnect to is already
 * persistent, so `readTextFile`/write etc. just hit the same filesystem every
 * turn. Nothing needs to be paused/remembered; `destroy()` only closes the SSH
 * connection.
 */

export interface SshSandboxOptions {
  /** Hostname/ip of the sandbox host (e.g. your Nest container). */
  host: string;
  /** SSH user on the host. */
  username: string;
  port?: number;
  /** Prefer a private key (Nest/`ssh-copy-id` style). */
  privateKey?: string;
  privateKeyPassphrase?: string;
  /** Or a password, if no key is provisioned. */
  password?: string;
  /** Directory commands run in by default, created on demand. */
  workdir?: string;
  /** Shell command run once whenever the SSH connection is (re)established. */
  bootstrapCommand?: string;
  /** Execution timeout per command, in ms. Default 20 minutes. */
  timeoutMs?: number;
  logger?: Logger;
}

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const DEFAULT_WORKDIR = '/home/user';
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/** naive POSIX single-quote escaping for an arbitrary string  */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A random token embedded in the wire protocol so command output can't collide with our markers. */
function token(): string {
  return `kyto${randomBytes(6).toString('hex')}`;
}

/** Public config made readable so callers can log where sessions point. */
export interface SshSandboxState {
  materialized: boolean;
}

class SshTimeoutError extends Error {
  constructor(host: string, timeoutMs: number) {
    super(`ssh command timed out after ${timeoutMs}ms on ${host}`);
    this.name = 'SshTimeoutError';
  }
}

export class SshSandbox {
  readonly workDir: string;
  readonly host: string;

  private readonly cfg: Required<
    Pick<SshSandboxOptions, 'port' | 'timeoutMs'>
  > &
    SshSandboxOptions;
  private readonly logger: Logger | undefined;
  private conn: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(options: SshSandboxOptions) {
    this.cfg = {
      port: options.port ?? 22,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...options,
    };
    this.host = options.host;
    this.workDir = options.workdir ?? DEFAULT_WORKDIR;
    this.logger = options.logger;
  }

  get materialized(): boolean {
    return this.conn !== null;
  }

  private connectConfig(): ConnectConfig {
    const { host, port, username, privateKey, privateKeyPassphrase, password } =
      this.cfg;
    if (!privateKey && !password) {
      throw new Error(
        'SshSandbox: no auth configured — set privateKey or password'
      );
    }
    const cfg: ConnectConfig = {
      host,
      port,
      username,
      readyTimeout: 30_000,
      keepaliveInterval: 30_000,
      keepaliveCountMax: 3,
    };
    if (privateKey) {
      cfg.privateKey = privateKey;
      cfg.passphrase = privateKeyPassphrase;
    } else {
      cfg.password = password;
    }
    return cfg;
  }

  private async connect(): Promise<Client> {
    if (this.conn?.shell) {
      return this.conn;
    }
    this.connecting ??= new Promise<Client>((resolve, reject) => {
      const client = new Client();
      client
        .on('error', (err) => {
          this.logger?.warn(
            { err: String(err), host: this.host },
            '[ssh-sandbox] connection error'
          );
          reject(err);
        })
        .on('ready', () => {
          resolve(client);
        })
        .connect(this.connectConfig());
    }).then(async (client) => {
      this.conn = client;
      this.connecting = null;
      if (this.cfg.bootstrapCommand) {
        await this.exec(this.cfg.bootstrapCommand, { timeoutMs: 60_000 });
      }
      return client;
    });
    return this.connecting;
  }

  private async exec(
    script: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const client = await this.connect();
    const timeoutMs = opts.timeoutMs ?? this.cfg.timeoutMs;
    opts.signal?.throwIfAborted();

    return await new Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const execOpts: ExecOptions = { pty: false };
      client.exec('bash --noprofile --norc -s', execOpts, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        const outChunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => outChunks.push(chunk));
        stream.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
        stream.on('close', (code: number, signal: string) => {
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
          const stdout = Buffer.concat(outChunks).toString('utf8');
          const stderr = Buffer.concat(errChunks).toString('utf8');
          if (signal) {
            reject(
              new Error(`ssh command killed by signal ${signal} on ${this.host}`)
            );
            return;
          }
          resolve({ exitCode: code, stdout, stderr });
        });

        const onAbort = () => {
          clearTimeout(timer);
          stream.destroy();
          reject(new Error('ssh command aborted'));
        };
        const timer = setTimeout(() => {
          stream.destroy();
          reject(new SshTimeoutError(this.host, timeoutMs));
        }, timeoutMs);
        if (opts.signal) {
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
        stream.write(script);
        stream.end();
      });
    });
  }

  /**
   * Build and run a remote bash script. stdout/stderr/exit are captured via a
   * marker protocol so we can split them deterministically. `command` is
   * embedded verbatim (it is never shell-quoted by us), so any shell syntax the
   * tool sends works.
   */
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
    return await this.runRaw(command, {
      cwd: workingDirectory ?? this.workDir,
      env,
      signal: abortSignal,
    }).then((r) => ({
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
    }));
  }

  private async runRaw(
    command: string,
    opts: { cwd: string; env?: Record<string, string>; signal?: AbortSignal }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const marker = token();
    const envLines = Object.entries({ ...(opts.env ?? {}) })
      .map(([k, v]) => `export ${k}=${shq(v)}`)
      .join('\n');
    // Capture exit code + split streams via temp files so big/odd output is safe.
    const script = [
      'set +e',
      `cd ${shq(opts.cwd)} || { echo "__${marker}_CD_FAIL__"; exit 98; }`,
      envLines,
      `OUT=$(mktemp)`,
      `ERR=$(mktemp)`,
      '(',
      command,
      `) >"$OUT" 2>"$ERR"`,
      'CODE=$?',
      `printf '%s %s %s %s\\n' '__${marker}_END__' "$CODE" "$(wc -c <"$OUT")" "$(wc -c <"$ERR")"`,
      `cat "$OUT"`,
      `printf '%s\\n' '__${marker}_BODY2__'`,
      `cat "$ERR"`,
      `rm -f "$OUT" "$ERR"`,
      'exit 0',
    ].join('\n');

    const result = await this.exec(script, {
      timeoutMs: this.cfg.timeoutMs,
      signal: opts.signal,
    });

    // First END marker line is ours (printed before any command stdout).
    const endIdx = result.stdout.indexOf(`__${marker}_END__`);
    if (endIdx === -1) {
      if (result.stdout.includes(`__${marker}_CD_FAIL__`)) {
        return { exitCode: 98, stdout: '', stderr: `cd failed: ${opts.cwd}` };
      }
      throw new Error('ssh-sandbox: protocol marker missing from output');
    }
    const after = result.stdout.slice(endIdx);
    const newlineIdx = after.indexOf('\n');
    const header = newlineIdx === -1 ? after : after.slice(0, newlineIdx);
    const exitCode = Number(header.split(' ')[1] ?? NaN);
    const body = (newlineIdx === -1 ? '' : after.slice(newlineIdx + 1)); // after header line
    const body2Idx = body.indexOf(`__${marker}_BODY2__\n`);
    const stdout = body2Idx === -1 ? body : body.slice(0, body2Idx);
    const stderr =
      body2Idx === -1
        ? ''
        : body.slice(body2Idx + `__${marker}_BODY2__\n`.length);
    return { exitCode, stdout, stderr };
  }

  async readBinaryFile({ path }: { path: string }): Promise<Uint8Array | null> {
    const marker = token();
    const script = [
      'set +e',
      `if [ -f ${shq(path)} ]; then base64 < ${shq(path)}; echo "__${marker}_END_B64__"; else echo "__${marker}_MISS__"; fi`,
    ].join('\n');
    const result = await this.exec(script, { timeoutMs: this.cfg.timeoutMs });
    const missing = result.stdout.indexOf(`__${marker}_MISS__`);
    if (missing !== -1) {
      return null;
    }
    const end = result.stdout.indexOf(`__${marker}_END_B64__`);
    const b64 =
      end === -1 ? result.stdout : result.stdout.slice(0, end);
    return Buffer.from(b64.replace(/\s+/g, ''), 'base64');
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
    const script = [
      'set +e',
      `DIR=$(dirname ${shq(path)}); mkdir -p "$DIR" || { echo "__MK_FAIL__"; exit 1; }`,
      '(base64 -d > ' +
        shq(path) +
        ") <<'__B64__'\n",
      Buffer.from(content).toString('base64'),
      '__B64__',
      'echo "__WRITE_DONE__"',
    ].join('\n');
    const result = await this.exec(script, { timeoutMs: this.cfg.timeoutMs });
    if (result.exitCode !== 0 || result.stdout.includes('__MK_FAIL__')) {
      throw new Error(
        `ssh-sandbox: write failed (${result.exitCode}) ${result.stderr.trim()}`
      );
    }
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

  /** Closes the SSH connection. No pause/kill semantics needed — files persist on the host. */
  async destroy(): Promise<void> {
    const conn = this.conn;
    this.conn = null;
    this.connecting = null;
    if (conn) {
      conn.end();
    }
  }

  /** Alias for callers that prefer a symmetric name to the E2B pause/kill. */
  async kill(): Promise<void> {
    await this.destroy();
  }

  /** No-op: the host is always "running"; present for interface symmetry. */
  async setTimeout(_ms: number): Promise<void> {}

  /** No-op: filesystem is inherently resumable; present for interface symmetry. */
  async pause(): Promise<boolean> {
    return true;
  }
}

/**
 * Read an SSH-sandbox config from the standard `SSH_SANDBOX_*` env vars.
 * Returns undefined when `SSH_SANDBOX_HOST` is unset — the caller then falls
 * back to E2B. When a host IS set, the private key is read from the file at
 * `SSH_SANDBOX_PRIVATE_KEY` (required), which keeps the actual key out of
 * `process.env`'s printed surface.
 */
export async function sshSandboxFromEnv(
  env: Record<string, string | undefined>,
  logger?: Logger
): Promise<SshSandboxOptions | undefined> {
  const host = env.SSH_SANDBOX_HOST?.trim();
  if (!host) {
    return undefined;
  }
  const keyPath = env.SSH_SANDBOX_PRIVATE_KEY;
  if (!keyPath) {
    throw new Error(
      'SSH_SANDBOX_HOST is set but SSH_SANDBOX_PRIVATE_KEY is missing'
    );
  }
  const { readFile } = await import('node:fs/promises');
  const privateKey = await readFile(keyPath, 'utf8');
  return {
    host,
    username: env.SSH_SANDBOX_USER ?? 'root',
    port: env.SSH_SANDBOX_PORT ? Number(env.SSH_SANDBOX_PORT) : 22,
    privateKey,
    workdir: env.SSH_SANDBOX_WORKDIR,
    bootstrapCommand: env.SSH_SANDBOX_BOOTSTRAP,
    ...(logger ? { logger } : {}),
  };
}

/** True when an SSH sandbox host is configured in the given env. */
export function sshSandboxConfigured(
  env: Record<string, string | undefined>
): boolean {
  return Boolean(env.SSH_SANDBOX_HOST?.trim());
}

