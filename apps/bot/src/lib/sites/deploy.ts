import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import type { SandboxContext } from '@repo/ai';
import logger from '@/lib/logger';
import {
  RESERVED_SITE_NAMES,
  resolveWithin,
  siteRoot,
  sitesRoot,
  siteUrl,
} from './paths';

// Limits keep a single deploy from exhausting host disk or hanging on a huge
// build directory. Static sites are small; these are generous ceilings.
const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

type Session = SandboxContext['session'];

export type DeployResult =
  | { ok: true; fileCount: number; totalBytes: number }
  | { ok: false; error: string };

/** A rejected-by-default check on each relative path from the sandbox. */
function isSafeRelative(relative: string): boolean {
  if (!relative || relative.includes('\0') || nodePath.isAbsolute(relative)) {
    return false;
  }
  return relative
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

async function listSandboxFiles(
  session: Session,
  sourceDir: string
): Promise<string[]> {
  // -type f excludes symlinks, so we never copy a link that points outside the
  // build directory. Paths come back relative to sourceDir (find . -type f).
  const result = await session.run({
    command: 'find . -type f -printf "%P\\n"',
    workingDirectory: sourceDir,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Could not list files in ${sourceDir}`);
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Copy a built static site out of the E2B sandbox to the host, file by file,
 * validating every destination path stays within the site root. Builds into a
 * staging directory, then atomically swaps it into place so a half-finished or
 * malicious deploy never leaves a partial site live.
 *
 * When `page` is given (e.g. `home` or `docs/intro`), only that sub-path of the
 * site is swapped — the rest of the site is left untouched, so pages can be
 * published incrementally. Without `page`, the whole site is replaced.
 */
export async function deploySiteFromSandbox({
  name,
  page,
  session,
  sourceDir,
}: {
  name: string;
  page?: string;
  session: Session;
  sourceDir: string;
}): Promise<DeployResult> {
  const files = await listSandboxFiles(session, sourceDir);
  if (files.length === 0) {
    return { error: `No files found in ${sourceDir}.`, ok: false };
  }
  if (files.length > MAX_FILES) {
    return {
      error: `Too many files (${files.length} > ${MAX_FILES}).`,
      ok: false,
    };
  }

  const siteDir = siteRoot(name);
  // Destination is the whole site, or — for a single-page deploy — a contained
  // sub-path within it. resolveWithin rejects any traversal outside the site.
  let finalRoot = siteDir;
  if (page) {
    const resolved = resolveWithin(siteDir, page);
    if (!resolved || resolved === siteDir) {
      return { error: `Invalid page path: ${page}`, ok: false };
    }
    finalRoot = resolved;
  }
  const staging = nodePath.join(
    sitesRoot(),
    '.staging',
    `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );

  let totalBytes = 0;
  try {
    await mkdir(staging, { recursive: true });

    for (const relative of files) {
      if (!isSafeRelative(relative)) {
        return { error: `Unsafe path in build: ${relative}`, ok: false };
      }
      const dest = resolveWithin(staging, relative);
      if (!dest) {
        return { error: `Path escapes site root: ${relative}`, ok: false };
      }

      const bytes = await session.readBinaryFile({
        path: nodePath.posix.join(sourceDir, relative),
      });
      if (!bytes) {
        return { error: `Could not read ${relative} from sandbox.`, ok: false };
      }
      if (bytes.byteLength > MAX_FILE_BYTES) {
        return { error: `File too large: ${relative}`, ok: false };
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) {
        return { error: 'Site exceeds total size limit.', ok: false };
      }

      await mkdir(nodePath.dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
    }

    // Atomic swap: replace the existing site (or page sub-path) in one rename.
    // For a page deploy the parent dirs may not exist yet, and siblings must
    // survive — so only the page sub-path is removed, not the whole site.
    await mkdir(nodePath.dirname(finalRoot), { recursive: true });
    await rm(finalRoot, { force: true, recursive: true });
    await rename(staging, finalRoot);

    logger.info(
      { fileCount: files.length, name, totalBytes },
      '[sites] deployed site'
    );
    return { fileCount: files.length, ok: true, totalBytes };
  } finally {
    await rm(staging, { force: true, recursive: true }).catch(() => {
      // best-effort cleanup; the staging dir is unique per deploy
    });
  }
}

/** Remove a deployed site (or a single page within it) from the host. */
export async function removeSite(name: string, page?: string): Promise<void> {
  const siteDir = siteRoot(name);
  let target = siteDir;
  if (page) {
    const resolved = resolveWithin(siteDir, page);
    if (!resolved || resolved === siteDir) {
      throw new Error(`Invalid page path: ${page}`);
    }
    target = resolved;
  }
  await rm(target, { force: true, recursive: true });
  logger.info({ name, page }, '[sites] removed site');
}

export interface DeployedSite {
  name: string;
  url: string;
}

/** List the sites currently published on the host (top-level dirs under the
 * sites root, excluding reserved/internal names). */
export async function listSites(): Promise<DeployedSite[]> {
  const entries = await readdir(sitesRoot(), { withFileTypes: true }).catch(
    () => []
  );
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        !RESERVED_SITE_NAMES.has(entry.name)
    )
    .map((entry) => ({ name: entry.name, url: siteUrl(entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
