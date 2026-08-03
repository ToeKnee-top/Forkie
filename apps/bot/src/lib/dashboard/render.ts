import type { GithubRequest, GithubTrust, Memory } from '@repo/db/queries';

// Server-rendered HTML, no client framework and no external assets: the page is
// served off the same host as user-deployed sites, so the less it loads the
// less there is to go wrong. Forms post and the page re-renders.

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
:root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --muted:#6b7280;
  --line:#e5e7eb; --card:#fafafa; --accent:#4338ca; --danger:#b91c1c; }
@media (prefers-color-scheme: dark) { :root { --bg:#141416; --fg:#ececec;
  --muted:#9ca3af; --line:#2c2c30; --card:#1c1c1f; --accent:#a5b4fc;
  --danger:#fca5a5; } }
* { box-sizing:border-box; }
body { margin:0; padding:2rem 1rem 4rem; background:var(--bg); color:var(--fg);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:56rem; margin:0 auto; }
h1 { font-size:1.35rem; margin:0 0 .25rem; }
h2 { font-size:1.05rem; margin:2.5rem 0 .75rem; }
a { color:var(--accent); }
.muted { color:var(--muted); font-size:.85rem; }
.card { border:1px solid var(--line); border-radius:.6rem; background:var(--card);
  padding:.85rem 1rem; margin-bottom:.6rem; }
.row { display:flex; gap:1rem; align-items:baseline; justify-content:space-between;
  flex-wrap:wrap; }
.tag { font-size:.7rem; text-transform:uppercase; letter-spacing:.04em;
  border:1px solid var(--line); border-radius:.3rem; padding:.1rem .4rem;
  color:var(--muted); }
.tag.global { color:var(--accent); border-color:var(--accent); }
pre { white-space:pre-wrap; word-break:break-word; background:var(--bg);
  border:1px solid var(--line); border-radius:.4rem; padding:.75rem;
  font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-x:auto; }
form { display:inline; }
button { font:inherit; cursor:pointer; border:1px solid var(--line);
  border-radius:.35rem; background:transparent; color:var(--fg);
  padding:.3rem .7rem; }
button:hover { border-color:var(--accent); color:var(--accent); }
button.danger:hover { border-color:var(--danger); color:var(--danger); }
input[type=password], input[type=text] { font:inherit; padding:.45rem .6rem;
  border:1px solid var(--line); border-radius:.35rem; background:var(--bg);
  color:var(--fg); min-width:16rem; }
.err { color:var(--danger); }
.actions { display:flex; gap:.4rem; flex-wrap:wrap; margin-top:.6rem; }
table { border-collapse:collapse; width:100%; }
td, th { text-align:left; padding:.4rem .5rem; border-bottom:1px solid var(--line); }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

export function loginPage(error?: string): string {
  return page(
    'kyto dashboard',
    `<h1>kyto dashboard</h1>
<p class="muted">Owner only.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/_dashboard/login">
  <input type="password" name="password" placeholder="Password" autofocus required>
  <button type="submit">Sign in</button>
</form>`
  );
}

function hidden(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
}

// A resolved `{ userId → display name }` map. The dashboard shows the name and
// keeps the raw id alongside in muted text, so a grant is still auditable by id.
type Names = Map<string, string>;

function userLabel(userId: string, names?: Names): string {
  const name = names?.get(userId);
  return name && name !== userId
    ? `${escapeHtml(name)} <span class="muted">(${escapeHtml(userId)})</span>`
    : escapeHtml(userId);
}

function memoryCard(memory: Memory, names?: Names): string {
  const tag = memory.isGlobal
    ? '<span class="tag global">global</span>'
    : '<span class="tag">private</span>';
  return `<div class="card"><div class="row">
  <div><a href="/_dashboard/memory/${memory.id}">${escapeHtml(memory.title)}</a> ${tag}
    <div class="muted">${escapeHtml(memory.summary)}</div>
    <div class="muted">saved by ${userLabel(memory.createdBy, names)} · ${memory.createdAt.toISOString().slice(0, 10)}</div>
  </div></div></div>`;
}

function requestCard(
  request: GithubRequest,
  csrf: string,
  names?: Names
): string {
  return `<div class="card">
  <div><strong>${escapeHtml(request.repo)}</strong> <span class="muted">requested by ${userLabel(request.userId, names)} · ${request.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</span></div>
  <pre>${escapeHtml(request.command)}</pre>
  <div class="actions">
    <form method="post" action="/_dashboard/github/request/${request.id}/approve">${hidden(csrf)}
      <button type="submit">Approve this repo</button></form>
    <form method="post" action="/_dashboard/github/request/${request.id}/approve-all">${hidden(csrf)}
      <button type="submit">Trust for all repos</button></form>
    <form method="post" action="/_dashboard/github/request/${request.id}/reject">${hidden(csrf)}
      <button class="danger" type="submit">Reject</button></form>
  </div></div>`;
}

function trustRow(trust: GithubTrust, csrf: string, names?: Names): string {
  const scope = trust.allRepos ? 'all repos' : trust.repos.join(', ') || 'none';
  return `<tr><td>${userLabel(trust.userId, names)}</td><td class="muted">${escapeHtml(scope)}</td>
  <td><form method="post" action="/_dashboard/github/trust/${encodeURIComponent(trust.userId)}/revoke">${hidden(csrf)}
    <button class="danger" type="submit">Revoke</button></form></td></tr>`;
}

export function overviewPage({
  csrf,
  memories,
  requests,
  trust,
  names,
}: {
  csrf: string;
  memories: Memory[];
  requests: GithubRequest[];
  trust: GithubTrust[];
  names?: Names;
}): string {
  const pending = memories.filter((memory) => !memory.isGlobal);
  const global = memories.filter((memory) => memory.isGlobal);
  return page(
    'kyto dashboard',
    `<div class="row"><h1>kyto dashboard</h1>
  <form method="post" action="/_dashboard/logout">${hidden(csrf)}
    <button type="submit">Sign out</button></form></div>

<h2>Pending GitHub requests (${requests.length})</h2>
${
  requests.length === 0
    ? '<p class="muted">Nothing waiting.</p>'
    : requests.map((request) => requestCard(request, csrf, names)).join('')
}

<h2>GitHub trust (${trust.length})</h2>
${
  trust.length === 0
    ? '<p class="muted">Nobody is trusted to write to repos kyto does not own.</p>'
    : `<table><tr><th>User</th><th>Scope</th><th></th></tr>${trust.map((row) => trustRow(row, csrf, names)).join('')}</table>`
}
<div class="actions">
  <form method="post" action="/_dashboard/github/trust">${hidden(csrf)}
    <input type="text" name="userId" placeholder="Slack user id (U…)" required>
    <button type="submit">Trust for all repos</button></form>
</div>

<h2>Memories awaiting review (${pending.length})</h2>
<p class="muted">Private to whoever saved them until you promote one. Read the body before promoting: a promoted memory is prompt text on everyone's turns.</p>
${
  pending.length === 0
    ? '<p class="muted">Nothing to review.</p>'
    : pending.map((memory) => memoryCard(memory, names)).join('')
}

<h2>Global memories (${global.length})</h2>
${
  global.length === 0
    ? '<p class="muted">None promoted yet.</p>'
    : global.map((memory) => memoryCard(memory, names)).join('')
}`
  );
}

export function memoryPage({
  csrf,
  memory,
  names,
}: {
  csrf: string;
  memory: Memory;
  names?: Names;
}): string {
  return page(
    memory.title,
    `<p class="muted"><a href="/_dashboard">&larr; back</a></p>
<h1>${escapeHtml(memory.title)} ${memory.isGlobal ? '<span class="tag global">global</span>' : '<span class="tag">private</span>'}</h1>
<p class="muted">saved by ${userLabel(memory.createdBy, names)} · ${memory.createdAt.toISOString().replace('T', ' ').slice(0, 16)}${
      memory.promotedAt
        ? ` · promoted ${memory.promotedAt.toISOString().slice(0, 10)}`
        : ''
    }</p>
<p>${escapeHtml(memory.summary)}</p>
<pre>${escapeHtml(memory.body)}</pre>
<div class="actions">
${
  memory.isGlobal
    ? `<form method="post" action="/_dashboard/memory/${memory.id}/demote">${hidden(csrf)}
    <button type="submit">Make private again</button></form>`
    : `<form method="post" action="/_dashboard/memory/${memory.id}/promote">${hidden(csrf)}
    <button type="submit">Promote to global</button></form>`
}
  <form method="post" action="/_dashboard/memory/${memory.id}/delete">${hidden(csrf)}
    <button class="danger" type="submit">Delete</button></form>
</div>`
  );
}
