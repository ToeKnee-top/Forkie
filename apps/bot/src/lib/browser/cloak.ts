import type { SandboxContext } from '@repo/ai';

// The browser tool drives the `agent-browser` CLI, but not against the plain
// Chrome-for-Testing build it installs by default: it points it, over CDP, at
// CloakBrowser — a Chromium whose fingerprint is patched at the C++ level, so
// bot-detection (Cloudflare Turnstile, FingerprintJS, reCAPTCHA scoring) treats
// it as an ordinary browser. Fewer pages hand us a challenge in the first place.
//
// The stealth binary (~200MB) is fetched on first use and cached under $HOME, so
// in a thread's persistent sandbox this cost is paid once. The Chromium PROCESS
// does not survive a sandbox pause, so every browser command re-runs this script
// — it exits immediately when the CDP endpoint is already answering.
const CDP_PORT = 9222;

const ENSURE_SCRIPT = `
set -u
CDP=${CDP_PORT}
alive() { curl -sf -m 2 "http://127.0.0.1:$CDP/json/version" >/dev/null 2>&1; }

if alive; then
  echo "cloakbrowser: already running"
  exit 0
fi

if ! command -v cloakbrowser >/dev/null 2>&1; then
  sudo npm install -g cloakbrowser >/tmp/cloak-install.log 2>&1 \
    || npm install -g cloakbrowser >>/tmp/cloak-install.log 2>&1
fi
# 'cloakbrowser install' downloads the binary if needed and prints its path.
BIN="$(cloakbrowser install 2>/dev/null | tail -n1)"
if [ ! -x "$BIN" ]; then
  echo "cloakbrowser: could not install the stealth chromium binary"
  tail -n 20 /tmp/cloak-install.log 2>/dev/null
  exit 1
fi

# Some sites detect headless even through the C++ patches, so run HEADFUL on the
# sandbox's ONE shared display (kyto-display, installed at materialization —
# idempotent, and it clears the stale lock that used to make every later start
# fail). Previously this wrapped Chromium in \`xvfb-run -a\`, a throwaway display
# per launch that a model-written script's own Xvfb then fought over.
DISPLAY_ID="$(kyto-display 2>>/tmp/cloak.log)"

SEED=$(( ($$ % 90000) + 10000 ))
ARGS="--remote-debugging-port=$CDP --no-sandbox --fingerprint=$SEED --fingerprint-platform=windows --user-data-dir=$HOME/.cloakbrowser-profile"
wait_alive() {
  i=0
  while [ $i -lt 60 ]; do
    alive && return 0
    i=$((i + 1))
    sleep 0.5
  done
  return 1
}

if [ -n "$DISPLAY_ID" ]; then
  nohup env DISPLAY="$DISPLAY_ID" "$BIN" $ARGS >>/tmp/cloak.log 2>&1 &
else
  nohup "$BIN" $ARGS --headless=new >>/tmp/cloak.log 2>&1 &
fi

# The display path can fail for its own reasons (a missing xauth once took the
# whole tool down) — a headless stealth browser beats no browser, so retry
# headless before giving up.
if ! wait_alive; then
  echo "cloakbrowser: headful launch failed, retrying headless" >>/tmp/cloak.log
  nohup "$BIN" $ARGS --headless=new >>/tmp/cloak.log 2>&1 &
  if ! wait_alive; then
    echo "cloakbrowser: chromium did not come up"
    tail -n 20 /tmp/cloak.log 2>/dev/null
    exit 1
  fi
fi

# Point agent-browser at the stealth Chromium instead of its own Chrome.
agent-browser connect $CDP >/dev/null 2>&1 || true
echo "cloakbrowser: ready"
`;

export type EnsureResult = { ok: true } | { ok: false; error: string };

/**
 * Make sure a CloakBrowser Chromium is running in the sandbox and that
 * agent-browser is attached to it. Cheap (a curl) once it is up.
 */
export async function ensureCloakBrowser({
  abortSignal,
  context,
}: {
  abortSignal?: AbortSignal;
  context: SandboxContext;
}): Promise<EnsureResult> {
  const result = await context.session.run({
    abortSignal,
    command: ENSURE_SCRIPT,
    workingDirectory: context.sessionWorkDir,
  });
  if (result.exitCode === 0) {
    return { ok: true };
  }
  return {
    error:
      `Could not start the stealth browser: ${result.stdout.trim() || result.stderr.trim()}`.trim(),
    ok: false,
  };
}
