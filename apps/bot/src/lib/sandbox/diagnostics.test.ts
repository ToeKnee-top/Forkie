import { afterAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import type { SandboxContext } from '@repo/ai';
import { fileDiagnostics } from './diagnostics';

// SandboxContext is structural, so the checks can be exercised against the LOCAL
// shell instead of a real E2B sandbox. That is the point of these tests: they run
// the ACTUAL commands (node --check, py_compile, bash -n, bun, tsc) rather than
// asserting against a mock of what we hope they print — a checker that silently
// stops working is exactly the failure this module must not have.

function localSession(): SandboxContext['session'] {
  return {
    destroy: () => Promise.resolve(),
    readBinaryFile: () => Promise.resolve(null),
    run: ({ command }) =>
      new Promise((resolve) => {
        const child = spawn('bash', ['-c', command]);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('close', (code) => {
          resolve({ exitCode: code ?? 0, stderr, stdout });
        });
      }),
    writeBinaryFile: () => Promise.resolve(),
  };
}

const roots: string[] = [];

/**
 * This repo's own `tsc`, found by walking up from this file — NOT from
 * `process.cwd()`, which differs between `bun test` at the repo root and inside
 * `apps/bot` and made the typecheck case pass in one and fail in the other.
 */
function repoTsc(): string {
  let dir = import.meta.dir;
  while (dir !== '/') {
    const candidate = nodePath.join(dir, 'node_modules', '.bin', 'tsc');
    if (existsSync(candidate)) {
      return candidate;
    }
    dir = nodePath.dirname(dir);
  }
  throw new Error('could not find node_modules/.bin/tsc above this test');
}

async function fixture(name: string, content: string): Promise<string> {
  // A fresh directory per fixture: the project typecheck is debounced per
  // sandbox+directory, so sharing one would make later cases silently skip.
  const root = await mkdtemp(nodePath.join(tmpdir(), 'kyto-diag-'));
  roots.push(root);
  const path = nodePath.join(root, name);
  await writeFile(path, content);
  return path;
}

function contextFor(path: string): SandboxContext {
  return { session: localSession(), sessionWorkDir: nodePath.dirname(path) };
}

async function check(name: string, content: string) {
  const path = await fixture(name, content);
  return await fileDiagnostics({ context: contextFor(path), path });
}

afterAll(async () => {
  await Promise.all(
    roots.map((root) =>
      import('node:fs/promises').then((fs) =>
        fs.rm(root, { force: true, recursive: true })
      )
    )
  );
});

describe('fileDiagnostics', () => {
  test('reports a python syntax error', async () => {
    const result = await check('broken.py', 'def f(:\n');
    expect(result?.checker).toBe('py_compile');
    expect(result?.output).toContain('SyntaxError');
  });

  test('says nothing about valid python', async () => {
    expect(await check('fine.py', 'def f():\n    return 1\n')).toBeUndefined();
  });

  test('reports a javascript syntax error', async () => {
    const result = await check('broken.js', 'let x = ;\n');
    expect(result?.checker).toBe('node --check');
    expect(result?.output).toContain('SyntaxError');
  });

  test('reports a shell syntax error', async () => {
    const result = await check('broken.sh', 'if [ x ; then\n');
    expect(result?.checker).toBe('bash -n');
    expect(result?.output).toContain('syntax error');
  });

  test('reports invalid json', async () => {
    const result = await check('broken.json', '{"a": }\n');
    expect(result?.checker).toBe('json.load');
    expect(result?.output).toContain('JSONDecodeError');
  });

  test('says nothing about valid json', async () => {
    expect(await check('fine.json', '{"a": 1}\n')).toBeUndefined();
  });

  test('reports a typescript parse error', async () => {
    const result = await check('broken.ts', 'function f( {\n');
    expect(result?.checker).toBe('bun (parse)');
    expect(result?.output.length).toBeGreaterThan(0);
  });

  test('says nothing about a file type it does not know', async () => {
    expect(await check('notes.txt', 'this is not code {{{')).toBeUndefined();
  });

  test('says nothing when the file parses and has no project', async () => {
    // No tsconfig.json above a temp dir, so the typecheck bails out silently
    // rather than inventing a complaint.
    expect(await check('fine.ts', 'export const x = 1;\n')).toBeUndefined();
  });

  test('a checker that cannot run is silent, not an error', async () => {
    // Exit 127 (command not found) must be treated as "no opinion". Simulated by
    // a session that always reports it.
    const result = await fileDiagnostics({
      context: {
        session: {
          ...localSession(),
          run: () =>
            Promise.resolve({
              exitCode: 127,
              stderr: 'bash: node: command not found',
              stdout: '',
            }),
        },
        sessionWorkDir: '/work',
      },
      path: '/work/thing.js',
    });
    expect(result).toBeUndefined();
  });

  test('a sandbox failure is swallowed, not thrown', async () => {
    const result = await fileDiagnostics({
      context: {
        session: {
          ...localSession(),
          run: () => Promise.reject(new Error('sandbox died')),
        },
        sessionWorkDir: '/work',
      },
      path: '/work/thing.py',
    });
    expect(result).toBeUndefined();
  });
});

describe('fileDiagnostics typecheck', () => {
  test('reports a real type error through tsc', async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), 'kyto-diag-tsc-'));
    roots.push(root);
    await writeFile(
      nodePath.join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { noEmit: true, strict: true },
        include: ['*.ts'],
      })
    );
    // tsc is resolved by walking up from the tsconfig for node_modules/.bin/tsc,
    // so point the walk at this repo's own install.
    const binDir = nodePath.join(root, 'node_modules', '.bin');
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(binDir, { recursive: true })
    );
    await import('node:fs/promises').then((fs) =>
      fs.symlink(repoTsc(), nodePath.join(binDir, 'tsc'))
    );
    const path = nodePath.join(root, 'typed.ts');
    // Parses fine; only a TYPE check can see the problem.
    await writeFile(path, 'export const n: number = "not a number";\n');
    const result = await fileDiagnostics({ context: contextFor(path), path });
    expect(result?.checker).toBe('tsc --noEmit');
    expect(result?.output).toContain('typed.ts');
    expect(result?.output).toContain('not assignable');
  });
});
