import {
  decideGithubRequest,
  deleteMemory,
  getGithubRequest,
  getMemoryById,
  grantGithubTrust,
  listAllMemories,
  listGithubRequests,
  listGithubTrust,
  revokeGithubTrust,
  setMemoryGlobal,
} from '@repo/db/queries';
import { env } from '@/env';
import logger from '@/lib/logger';
import { resolveUserNames } from '@/lib/slack/names';
import { loginPage, memoryPage, overviewPage } from './render';
import {
  clearCookie,
  csrfValid,
  currentSession,
  dashboardEnabled,
  login,
  logout,
} from './session';

// The owner dashboard, mounted on the sites server (lib/sites/server.ts). It is
// the review desk for the two things kyto cannot safely decide on its own:
//
//  - which saved memories become GLOBAL, i.e. prompt text on everybody's turns;
//  - who is trusted to make kyto write to a GitHub repo it does not own.
//
// Both are privilege grants, so everything here is behind DASHBOARD_PASSWORD
// and every mutation is a POST carrying the session's CSRF token. Unset the
// password and the whole surface 404s.

export const DASHBOARD_PREFIX = '/_dashboard';

const HTML_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  // Nothing here should ever be cached or indexed, and it embeds no remote
  // anything, so lock the page down to its own inline stylesheet.
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
};

function html(body: string, extra?: Record<string, string>): Response {
  return new Response(body, { headers: { ...HTML_HEADERS, ...extra } });
}

function redirect(location: string, extra?: Record<string, string>): Response {
  return new Response(null, {
    headers: { ...HTML_HEADERS, Location: location, ...extra },
    status: 303,
  });
}

async function overview(csrf: string): Promise<Response> {
  const [memories, requests, trust] = await Promise.all([
    listAllMemories(),
    listGithubRequests('pending'),
    listGithubTrust(),
  ]);
  // Resolve every Slack id on the page to a real name so a grant reads as a
  // person, not a `U…`. Best-effort: an unresolvable id falls back to itself.
  const names = await resolveUserNames([
    ...memories.map((memory) => memory.createdBy),
    ...requests.map((request) => request.userId),
    ...trust.map((row) => row.userId),
  ]).catch(() => undefined);
  return html(overviewPage({ csrf, memories, names, requests, trust }));
}

/** Every mutation funnels through here: live session + matching CSRF token. */
function authorizeMutation(
  request: Request,
  submittedCsrf: string | null
): { csrf: string } | Response {
  const session = currentSession(request);
  if (!session) {
    return redirect(DASHBOARD_PREFIX);
  }
  if (!csrfValid(session, submittedCsrf)) {
    return new Response('Bad request', { headers: HTML_HEADERS, status: 400 });
  }
  return { csrf: session.csrf };
}

async function handleMemoryAction({
  action,
  id,
}: {
  action: string;
  id: number;
}): Promise<Response> {
  if (action === 'promote' || action === 'demote') {
    await setMemoryGlobal({ id, isGlobal: action === 'promote' });
    logger.info({ action, memoryId: id }, '[dashboard] memory scope changed');
    return redirect(`${DASHBOARD_PREFIX}/memory/${id}`);
  }
  if (action === 'delete') {
    await deleteMemory(id);
    logger.info({ memoryId: id }, '[dashboard] memory deleted');
    return redirect(DASHBOARD_PREFIX);
  }
  return new Response('Not found', { headers: HTML_HEADERS, status: 404 });
}

async function handleRequestAction({
  action,
  id,
}: {
  action: string;
  id: number;
}): Promise<Response> {
  const row = await getGithubRequest(id);
  if (!row) {
    return new Response('Not found', { headers: HTML_HEADERS, status: 404 });
  }
  if (action === 'reject') {
    await decideGithubRequest({ id, status: 'rejected' });
  } else if (action === 'approve' || action === 'approve-all') {
    // Approving grants the trust; the person then simply asks kyto again. The
    // original command is NOT replayed from here — it was composed by a model
    // in a thread that has since moved on, and re-running it blind is how an
    // approval click turns into an action nobody reviewed.
    await grantGithubTrust({
      allRepos: action === 'approve-all',
      grantedBy: env.OWNER_USER_ID ?? 'dashboard',
      repo: action === 'approve' ? row.repo : undefined,
      userId: row.userId,
    });
    await decideGithubRequest({ id, status: 'approved' });
  } else {
    return new Response('Not found', { headers: HTML_HEADERS, status: 404 });
  }
  logger.info(
    { action, repo: row.repo, requestId: id, userId: row.userId },
    '[dashboard] github request decided'
  );
  return redirect(DASHBOARD_PREFIX);
}

async function handlePost(
  request: Request,
  path: string
): Promise<Response | null> {
  const form = await request.formData().catch(() => null);
  if (!form) {
    return new Response('Bad request', { headers: HTML_HEADERS, status: 400 });
  }
  const field = (name: string): string | null => {
    const value = form.get(name);
    return typeof value === 'string' ? value : null;
  };

  if (path === '/login') {
    const result = login(field('password') ?? '');
    if (!result.ok) {
      logger.warn({ reason: result.reason }, '[dashboard] login refused');
      return html(loginPage(result.reason));
    }
    logger.info('[dashboard] signed in');
    return redirect(DASHBOARD_PREFIX, { 'Set-Cookie': result.cookie });
  }

  const authorized = authorizeMutation(request, field('csrf'));
  if (authorized instanceof Response) {
    return authorized;
  }

  if (path === '/logout') {
    logout(request);
    return redirect(DASHBOARD_PREFIX, { 'Set-Cookie': clearCookie() });
  }

  const memoryAction = /^\/memory\/(\d+)\/(promote|demote|delete)$/.exec(path);
  if (memoryAction) {
    return await handleMemoryAction({
      action: memoryAction[2] ?? '',
      id: Number(memoryAction[1]),
    });
  }

  const requestAction =
    /^\/github\/request\/(\d+)\/(approve|approve-all|reject)$/.exec(path);
  if (requestAction) {
    return await handleRequestAction({
      action: requestAction[2] ?? '',
      id: Number(requestAction[1]),
    });
  }

  if (path === '/github/trust') {
    const userId = field('userId')?.trim();
    if (userId) {
      await grantGithubTrust({
        allRepos: true,
        grantedBy: env.OWNER_USER_ID ?? 'dashboard',
        userId,
      });
      logger.info({ userId }, '[dashboard] github trust granted');
    }
    return redirect(DASHBOARD_PREFIX);
  }

  const revoke = /^\/github\/trust\/([^/]+)\/revoke$/.exec(path);
  if (revoke?.[1]) {
    await revokeGithubTrust(decodeURIComponent(revoke[1]));
    logger.info(
      { userId: decodeURIComponent(revoke[1]) },
      '[dashboard] github trust revoked'
    );
    return redirect(DASHBOARD_PREFIX);
  }

  return null;
}

/**
 * Handle a dashboard request, or return null so the sites server can fall
 * through to serving a static site.
 */
export async function handleDashboard(
  request: Request,
  pathname: string
): Promise<Response | null> {
  if (
    !(
      pathname === DASHBOARD_PREFIX ||
      pathname.startsWith(`${DASHBOARD_PREFIX}/`)
    )
  ) {
    return null;
  }
  // Unconfigured: behave exactly as if the route did not exist.
  if (!dashboardEnabled()) {
    return null;
  }

  const path = pathname.slice(DASHBOARD_PREFIX.length) || '/';

  try {
    if (request.method === 'POST') {
      return await handlePost(request, path);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', {
        headers: HTML_HEADERS,
        status: 405,
      });
    }

    const session = currentSession(request);
    if (!session) {
      return html(loginPage());
    }
    if (path === '/') {
      return await overview(session.csrf);
    }
    const memoryView = /^\/memory\/(\d+)$/.exec(path);
    if (memoryView) {
      const memory = await getMemoryById(Number(memoryView[1]));
      if (!memory) {
        return new Response('Not found', {
          headers: HTML_HEADERS,
          status: 404,
        });
      }
      const names = await resolveUserNames([memory.createdBy]).catch(
        () => undefined
      );
      return html(memoryPage({ csrf: session.csrf, memory, names }));
    }
    return new Response('Not found', { headers: HTML_HEADERS, status: 404 });
  } catch (error) {
    logger.error({ err: error, pathname }, '[dashboard] request failed');
    return new Response('Something went wrong', {
      headers: HTML_HEADERS,
      status: 500,
    });
  }
}
