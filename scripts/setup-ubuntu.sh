#!/usr/bin/env bash
# One-command development setup for DeskNotes on Ubuntu 24.04 (and close relatives).
#
#   scripts/setup-ubuntu.sh          install what is missing, then check everything
#   scripts/setup-ubuntu.sh --check  only report what is missing; change nothing
#
# What it does, in order (each step is skipped when already done):
#   1. installs the system packages Tauri needs (asks for your password via sudo)
#   2. installs rustup from https://rustup.rs if Rust is missing; the exact Rust
#      version comes from rust-toolchain.toml and is installed by rustup on first use
#   3. checks Node.js against .nvmrc (it does not install Node: see the message)
#   4. installs the JavaScript dependencies with `npm ci`
#   5. runs a quick build check
# Nothing here touches your notes or any data outside this folder and ~/.cargo, ~/.rustup.

set -euo pipefail

CHECK_ONLY=false
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=true

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APT_PACKAGES=(
  build-essential curl wget file pkg-config libssl-dev libgtk-3-dev
  libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
  librsvg2-dev libxdo-dev libayatana-appindicator3-dev patchelf
)

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
todo() { printf '  \033[33m•\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; }

MISSING=0

bold "1. System packages"
if ! command -v apt-get >/dev/null; then
  fail "apt-get not found. This script supports Ubuntu/Debian; see CONTRIBUTING.md for others."
  exit 1
fi
missing_pkgs=()
for pkg in "${APT_PACKAGES[@]}"; do
  dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed" || missing_pkgs+=("$pkg")
done
if ((${#missing_pkgs[@]} == 0)); then
  ok "all ${#APT_PACKAGES[@]} packages installed"
elif $CHECK_ONLY; then
  todo "missing: ${missing_pkgs[*]}"
  MISSING=1
else
  todo "installing: ${missing_pkgs[*]}"
  sudo apt-get update
  sudo apt-get install -y "${missing_pkgs[@]}"
  ok "system packages installed"
fi

bold "2. Rust"
if command -v rustup >/dev/null; then
  ok "rustup $(rustup --version 2>/dev/null | awk '{print $2}')"
  want="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)"
  if rustup toolchain list | grep -q "^$want"; then
    ok "Rust $want (from rust-toolchain.toml) installed"
  elif $CHECK_ONLY; then
    todo "Rust $want will be installed by rustup the first time you run cargo here"
    MISSING=1
  else
    todo "installing Rust $want (from rust-toolchain.toml)"
    rustup toolchain install "$want" --profile minimal --component rustfmt,clippy
    ok "Rust $want installed"
  fi
elif $CHECK_ONLY; then
  todo "rustup missing (install from https://rustup.rs)"
  MISSING=1
else
  todo "installing rustup from https://rustup.rs (the official installer)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none
  # shellcheck source=/dev/null
  source "$HOME/.cargo/env"
  rustup show active-toolchain >/dev/null # installs the version in rust-toolchain.toml
  ok "Rust installed: $(rustc --version)"
fi

bold "3. Node.js"
want_node="$(tr -d ' v\n' < .nvmrc)"
if command -v node >/dev/null; then
  have_node="$(node --version | sed 's/^v//')"
  if [[ "${have_node%%.*}" -ge "$want_node" ]]; then
    ok "Node $have_node (needs $want_node or newer)"
  else
    fail "Node $have_node is too old; DeskNotes needs Node $want_node."
    todo "with nvm: nvm install $want_node   (https://github.com/nvm-sh/nvm)"
    MISSING=1
  fi
else
  fail "Node.js not found; DeskNotes needs Node $want_node."
  todo "with nvm: nvm install $want_node   (https://github.com/nvm-sh/nvm)"
  MISSING=1
fi

bold "4. JavaScript dependencies"
if [[ -d node_modules ]]; then
  ok "node_modules present (run 'npm ci' to reinstall exactly)"
elif $CHECK_ONLY || ! command -v npm >/dev/null; then
  todo "run: npm ci"
  MISSING=1
else
  npm ci
  ok "dependencies installed"
fi

bold "5. Quick check"
if $CHECK_ONLY; then
  if pkg-config --exists webkit2gtk-4.1 2>/dev/null; then ok "WebKitGTK $(pkg-config --modversion webkit2gtk-4.1)"; else todo "WebKitGTK headers missing"; MISSING=1; fi
elif ((MISSING == 0)); then
  run_check() { # label, command...
    local label="$1"; shift
    if "$@" >/dev/null 2>&1; then ok "$label"; else fail "$label — failed; run: $*"; MISSING=1; fi
  }
  run_check "core tests pass" cargo test -p desknotes-core --quiet
  run_check "frontend tests pass" npm test --silent
  run_check "desktop app builds" cargo build -p desknotes --quiet
fi

echo
if ((MISSING == 0)); then
  bold "Ready. Start DeskNotes with:  npm run tauri dev"
else
  bold "Some steps need attention (see above)."
  exit 1
fi
