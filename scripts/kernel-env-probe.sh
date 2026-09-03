#!/bin/sh
# Starts the real kernel twice under a windowless Electron, once through the product path and
# once with the environment boundary bypassed, from a login shell poisoned with another
# product's config, a telemetry endpoint, a NODE_OPTIONS preload and the UI password. Green
# means the product path let none of it through and the bypass let all of it through
# (docs/ENVIRONMENT.md §7). Needs the staged kernel: `bun run prepare:geocode-kernel` first.
# macOS only for now: the environment-block check reads `ps -E`, which means something else on Linux.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON="$(cd "$ROOT/desktop/packages/electron" && node -e "console.log(require('electron'))")"
env -u NODE_OPTIONS "$ELECTRON" "$ROOT/scripts/kernel-env-probe"
