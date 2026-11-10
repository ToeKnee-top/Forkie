// live repo stats from the GitHub API (public, CORS-enabled)
(function () {
  var els = {
    stars: document.getElementById('st-stars'),
    forks: document.getElementById('st-forks'),
    issues: document.getElementById('st-issues'),
    pushed: document.getElementById('st-pushed'),
    lang: document.getElementById('st-lang')
  };

  function ago(iso) {
    if (!iso) return '–';
    var d = new Date(iso);
    var s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  fetch('https://api.github.com/repos/ToeKnee-top/Forkie')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && typeof d.stargazers_count === 'number') {
        els.stars.textContent = d.stargazers_count;
        els.forks.textContent = d.forks_count;
        els.issues.textContent = d.open_issues_count;
        els.pushed.textContent = ago(d.pushed_at);
        els.lang.textContent = d.language || '–';
      }
    })
    .catch(function () { /* leave the – placeholders */ });
})();
