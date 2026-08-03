import { execFile } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import nodePath from 'node:path';
import { promisify } from 'node:util';
import { env } from '@/env';
import { handleDashboard } from '@/lib/dashboard';
import logger from '@/lib/logger';
import { handleSlackProxy } from '@/lib/slack-proxy';
import { isValidSiteName, resolveWithin, siteRoot, sitesRoot } from './paths';

const execFileAsync = promisify(execFile);

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
};

async function ensureSelfSignedCert(): Promise<{ cert: string; key: string }> {
  const tlsDir = nodePath.join(sitesRoot(), '.tls');
  const certPath = nodePath.join(tlsDir, 'cert.pem');
  const keyPath = nodePath.join(tlsDir, 'key.pem');

  const existing = await Promise.all([
    readFile(certPath).catch(() => null),
    readFile(keyPath).catch(() => null),
  ]);
  if (existing[0] && existing[1]) {
    return { cert: existing[0].toString(), key: existing[1].toString() };
  }

  await mkdir(tlsDir, { recursive: true });
  // 10-year self-signed cert; browsers warn unless trusted, which is expected.
  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '3650',
    '-subj',
    `/CN=${env.SITES_PUBLIC_HOST ?? 'kyto-sites'}`,
  ]);
  logger.info({ tlsDir }, '[sites] generated self-signed certificate');
  return {
    cert: (await readFile(certPath)).toString(),
    key: (await readFile(keyPath)).toString(),
  };
}

function notFound(): Response {
  return new Response('Not found', { headers: SECURITY_HEADERS, status: 404 });
}

async function resolveSiteFile(pathname: string): Promise<string | null> {
  // Sites are served at the domain root: /<name>/<rest...>. The first path
  // segment is the site name; everything after it is a file or page within it.
  const remainder = pathname.replace(/^\/+/, '');
  const slash = remainder.indexOf('/');
  const name = slash === -1 ? remainder : remainder.slice(0, slash);
  if (!isValidSiteName(name)) {
    return null;
  }

  let rest = slash === -1 ? '' : remainder.slice(slash + 1);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    return null;
  }

  const root = siteRoot(name);
  const candidate = resolveWithin(root, rest);
  if (!candidate) {
    return null;
  }

  // Directory (or trailing slash / bare site) → serve its index.html.
  let target = candidate;
  const info = await stat(candidate).catch(() => null);
  if (!info || info.isDirectory()) {
    target = nodePath.join(candidate, 'index.html');
  }

  const fileInfo = await stat(target).catch(() => null);
  if (!fileInfo?.isFile()) {
    return null;
  }
  // Final guard: the resolved file must still live inside the site root.
  return resolveWithin(root, nodePath.relative(root, target));
}

/**
 * Start the static-site HTTPS server on SITES_PORT. Serves prebuilt files from
 * SITES_ROOT/<name>/ at the domain root under /<name>/ and nothing else — no
 * directory listings, no execution, strict path containment. Bind failures are logged and
 * swallowed so they never crash the bot (e.g. in local dev without port 8080).
 */
export async function startSitesServer(): Promise<void> {
  if (!env.SITES_ENABLED) {
    logger.info('[sites] hosting disabled (SITES_ENABLED=false)');
    return;
  }

  try {
    await mkdir(sitesRoot(), { recursive: true });
    // Behind a TLS-terminating proxy (e.g. Nest) the container must speak plain
    // HTTP; serving HTTPS there makes the proxy fail upstream with 502.
    const tls = env.SITES_TLS ? await ensureSelfSignedCert() : undefined;

    Bun.serve({
      fetch: async (request) => {
        const { pathname } = new URL(request.url);

        // Read-only Slack proxy (secret-gated) for sandbox scripts. Handled
        // before the static GET-only path since it's a POST endpoint.
        const proxied = await handleSlackProxy(request, pathname);
        if (proxied) {
          return proxied;
        }

        // Owner dashboard (memory promotion, GitHub trust). Password-gated, and
        // absent entirely when DASHBOARD_PASSWORD is unset. Also handled before
        // the GET-only path below, since its actions are form posts.
        const dashboard = await handleDashboard(request, pathname);
        if (dashboard) {
          return dashboard;
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return new Response('Method not allowed', {
            headers: SECURITY_HEADERS,
            status: 405,
          });
        }

        const filePath = await resolveSiteFile(pathname);
        if (!filePath) {
          return notFound();
        }
        return new Response(Bun.file(filePath), { headers: SECURITY_HEADERS });
      },
      port: env.SITES_PORT,
      ...(tls ? { tls } : {}),
    });
    logger.info(
      { port: env.SITES_PORT, tls: Boolean(tls) },
      '[sites] static host listening'
    );
  } catch (error) {
    logger.error({ err: error }, '[sites] failed to start static host');
  }
}
