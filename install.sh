#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OMHA_INSTALL_PREFIX=${OMHA_NPM_PREFIX:-"$HOME/.local"}
command -v npm >/dev/null 2>&1 || { printf 'npm is required\n' >&2; exit 1; }
npm install --global --prefix "$OMHA_INSTALL_PREFIX" "$ROOT" --ignore-scripts
printf 'Omha installed: %s\n' "$ROOT"
printf 'Add to PATH: %s/bin\n' "$OMHA_INSTALL_PREFIX"
printf 'Try: %s/bin/omha doctor --json\n' "$OMHA_INSTALL_PREFIX"
printf 'Claude: claude --plugin-dir %s\n' "$ROOT"
