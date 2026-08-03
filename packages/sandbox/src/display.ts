/**
 * ONE virtual display per sandbox, provided by code.
 *
 * Anti-bot checks (Cloudflare Turnstile, reCAPTCHA scoring) flag headless
 * Chromium even through CloakBrowser's fingerprint patches, so the browser has to
 * run HEADFUL — which needs an X display in a container that has no screen. Both
 * the `browser` tool and any script the model writes itself need it.
 *
 * It used to be each caller's problem, and they fought each other: the tool
 * wrapped Chromium in `xvfb-run -a` (a throwaway display per launch) while a
 * model-written script did its own `Xvfb :99`, hit "There's already an Xvfb
 * running", `pkill -f Xvfb`'d it — killing the browser out from under the tool —
 * and left `/tmp/.X99-lock` behind, after which every later start failed with
 * "Server is already active for display 99" even though nothing was running. The
 * observed end state was `node` timing out and kyto falling back to curl.
 *
 * So the display is a shared, fixed, self-healing resource: `kyto-display` is
 * installed on PATH at every materialization and is safe to run any number of
 * times, from anywhere. Nobody needs to start or clean up an X server again — the
 * prompt tells the model to run it (or just use the browser tool) and never to
 * launch its own.
 */

/** The one display every headful browser in the sandbox shares. */
export const SANDBOX_DISPLAY = ':99';

const DISPLAY_NUMBER = SANDBOX_DISPLAY.replace(':', '');

/**
 * Installs `kyto-display`: ensure the shared X server is up, then print the
 * DISPLAY to use (so `export DISPLAY=$(kyto-display)` works from a script).
 *
 * The lock check is the load-bearing part. Xvfb refuses to start when
 * `/tmp/.X<N>-lock` exists, and a killed-not-stopped server leaves that file
 * behind forever — the file alone is NOT evidence of a running server, so it is
 * removed when nothing is actually listening on the socket.
 */
export const DISPLAY_INSTALL_COMMAND = `cat > /usr/local/bin/kyto-display <<'KYTO_DISPLAY_HELPER'
#!/usr/bin/env bash
# Ensure the shared virtual display is running, then print it. Idempotent.
set -u
DISP="${SANDBOX_DISPLAY}"
NUM="${DISPLAY_NUMBER}"
LOCK="/tmp/.X\${NUM}-lock"
SOCK="/tmp/.X11-unix/X\${NUM}"

# A live display is a socket WITH a server behind it. Checking only one of the two
# is what produced both halves of the old bug: the socket file survives a kill,
# and a stale lock blocks a start even though nothing is serving.
socket_up() { [ -S "$SOCK" ]; }

# Already serving: nothing to do.
if socket_up && pgrep -f "Xvfb $DISP" >/dev/null 2>&1; then
  echo "$DISP"
  exit 0
fi

# A lock with no server behind it is stale — Xvfb would refuse to start ("Server
# is already active"), which is the failure that used to take the browser down.
if [ -e "$LOCK" ] && ! pgrep -f "Xvfb $DISP" >/dev/null 2>&1; then
  rm -f "$LOCK" "$SOCK" 2>/dev/null || sudo rm -f "$LOCK" "$SOCK" 2>/dev/null || true
fi

if ! command -v Xvfb >/dev/null 2>&1; then
  echo "kyto-display: Xvfb is not installed in this sandbox" >&2
  exit 1
fi

nohup Xvfb "$DISP" -screen 0 1920x1080x24 -nolisten tcp >/tmp/kyto-display.log 2>&1 &

# Wait for the socket rather than sleeping a fixed amount: Chromium started
# against a not-yet-ready display just dies.
i=0
while [ $i -lt 50 ]; do
  if socket_up; then
    echo "$DISP"
    exit 0
  fi
  i=$((i + 1))
  sleep 0.1
done
echo "kyto-display: display $DISP did not come up" >&2
tail -n 5 /tmp/kyto-display.log 2>/dev/null >&2
exit 1
KYTO_DISPLAY_HELPER
chmod +x /usr/local/bin/kyto-display`;
