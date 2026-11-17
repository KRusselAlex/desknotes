#!/bin/sh
# Runs the end-to-end tests (tests/e2e) against a built DeskNotes, isolated from the
# desktop: a hidden X display, a private D-Bus session (so the app never hands over to
# a DeskNotes already running), and scratch home, config, data and runtime folders.
# Usage: scripts/e2e/run.sh [vitest args…]   (app: $DESKNOTES_E2E_BINARY, default target/release/desknotes)
# Needs: Xvfb, xwininfo, dbus-run-session, flock, WebKitWebDriver and tauri-driver.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${DESKNOTES_E2E_BINARY:-$ROOT/target/release/desknotes}
case $BIN in /*) ;; *) BIN=$ROOT/$BIN ;; esac
[ -x "$BIN" ] || { echo "No app at $BIN. Build it first: npm run tauri build -- --no-bundle" >&2; exit 2; }
DRIVER=${TAURI_DRIVER:-$(command -v tauri-driver || echo "$HOME/.cargo/bin/tauri-driver")}
[ -x "$DRIVER" ] || { echo "tauri-driver not found: cargo install tauri-driver --locked" >&2; exit 2; }
for tool in WebKitWebDriver Xvfb xwininfo dbus-run-session flock; do
  command -v "$tool" >/dev/null || { echo "$tool not found (see CONTRIBUTING.md, End-to-end tests)" >&2; exit 2; }
done
# The stand-in notification service (tests/e2e/notifications.py) needs GLib's Python bindings.
python3 -I -c 'from gi.repository import Gio, GLib' 2>/dev/null ||
  { echo "python3 cannot import gi: sudo apt install python3-gi" >&2; exit 2; }

# One run at a time on this computer: the runs would share the app's processes.
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/desknotes-e2e.lock"
flock -n 9 || { echo "Waiting for another end-to-end run to finish…" >&2; flock 9; }

XVFB= TESTS=
SCRATCH=$(mktemp -d "/tmp/desknotes-e2e.XXXXXX")
cleanup() {
  [ -n "$TESTS" ] && kill -TERM -- "-$TESTS" 2>/dev/null || true
  [ -n "$XVFB" ] && kill "$XVFB" 2>/dev/null || true
  # The private bus's document portal and gvfs mount FUSE folders in the runtime folder.
  for m in "$SCRATCH/run/doc" "$SCRATCH/run/gvfs"; do fusermount3 -uz "$m" 2>/dev/null || true; done
  rm -rf --one-file-system "$SCRATCH"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# A hidden display; Xvfb picks a free number and reports it.
Xvfb -displayfd 8 -screen 0 1600x1000x24 -nolisten tcp 8>"$SCRATCH/display" >/dev/null 2>&1 &
XVFB=$!
i=0; until [ -s "$SCRATCH/display" ]; do
  i=$((i + 1)); { [ $i -gt 50 ] || ! kill -0 "$XVFB" 2>/dev/null; } && { echo "Xvfb did not start" >&2; exit 1; }; sleep 0.1
done

# Set before the bus starts: the services it starts inherit its environment.
export DISPLAY=":$(cat "$SCRATCH/display")" GDK_BACKEND=x11 HOME="$SCRATCH/home" \
  XDG_CONFIG_HOME="$SCRATCH/home/.config" XDG_CACHE_HOME="$SCRATCH/home/.cache" \
  XDG_STATE_HOME="$SCRATCH/home/.local/state" XDG_DATA_HOME="$SCRATCH/data" \
  XDG_RUNTIME_DIR="$SCRATCH/run" GSETTINGS_BACKEND=memory \
  DESKNOTES_E2E_BINARY="$BIN" DESKNOTES_E2E_TMP="$SCRATCH" TAURI_DRIVER="$DRIVER"
unset WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS GNOME_KEYRING_CONTROL SSH_AUTH_SOCK XAUTHORITY \
  SESSION_MANAGER GNOME_SETUP_DISPLAY XDG_SESSION_TYPE XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

cd "$ROOT"
# In its own process group, in the background, so Ctrl+C or a TERM stops it at once.
setsid dbus-run-session -- node_modules/.bin/vitest run --config vitest.e2e.config.ts "$@" &
TESTS=$!
STATUS=0
wait "$TESTS" || STATUS=$?
TESTS=
exit "$STATUS"
