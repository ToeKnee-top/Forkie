/**
 * Turn git/gh authentication failures into something the model can act on.
 *
 * kyto's GitHub credentials are brokered at the network egress layer, so from
 * inside the sandbox there is no token to inspect and no `gh auth status` that
 * means anything. When the brokered token is revoked or expired, every GitHub
 * command fails in a way that looks like something else entirely: a plain
 * `git clone` of a PUBLIC repo comes back with "could not read Username for
 * 'https://github.com'", because the proxy attaches a credential GitHub then
 * rejects, and git falls through to asking for one.
 *
 * That has already cost a turn: kyto read the message as evidence the repo was
 * private, went looking for other explanations, and reported an environment
 * fault. Naming the real cause — and the workaround that still works for public
 * repos — is the difference between a stuck turn and a useful one.
 */

// Deliberately excludes a bare `gh: Not Found` / HTTP 404. A missing repo and a
// rejected token both 404, and asserting "your credentials are dead" over an
// ordinary typo'd repo name would send a turn down the wrong path just as
// surely as saying nothing did. "Repository not found" from git itself stays,
// because that IS GitHub masking an auth failure on a fetch or push.
const AUTH_FAILURE =
  /could not read Username|Authentication failed|Invalid username or (?:password|token)|Bad credentials|HTTP 401|401 Unauthorized|remote: (?:Invalid|Repository not found)|requires authentication/i;

const TOUCHES_GITHUB = /github\.com|gh:\s|\bgh\b/i;

const HINT =
  "GitHub rejected kyto's brokered credentials. That token is injected at the network layer, so nothing inside the sandbox can read, refresh, or replace it, and `gh auth` commands won't help — it needs the bot owner to rotate GH_TOKEN, and a thread only picks up a rotated token on its NEXT fresh sandbox. Note this does NOT mean the repo is private or missing: this failure looks identical for a public repo, because the rejected credential is attached before GitHub ever considers the request anonymous. To read a PUBLIC repo meanwhile, skip git auth entirely and download the tarball, e.g. `curl -sL https://codeload.github.com/OWNER/REPO/tar.gz/refs/heads/main | tar xz`. Tell whoever asked that the token needs rotating rather than retrying the same command.";

/**
 * A hint to append to a failed command's result, or undefined when the failure
 * had nothing to do with GitHub auth.
 */
export function githubAuthHint({
  command,
  exitCode,
  stderr,
}: {
  command: string;
  exitCode: number;
  stderr: string;
}): string | undefined {
  if (exitCode === 0) {
    return;
  }
  if (!AUTH_FAILURE.test(stderr)) {
    return;
  }
  if (!(TOUCHES_GITHUB.test(command) || TOUCHES_GITHUB.test(stderr))) {
    return;
  }
  return HINT;
}
