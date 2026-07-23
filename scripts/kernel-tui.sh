#!/bin/sh
# Launch the vendored kernel (TUI by default) inside an isolated sandbox.
# Vanilla upstream behaviour for now — the GeoCode assembly layer comes later.
# XDG dirs, auth and the working project all land in the sandbox, never in the
# real opencode/geocode dirs. Delete the sandbox dir for a factory reset.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="${GEOCODE_KERNEL_HOME:-$HOME/.geocode-kernel-dev}"
mkdir -p "$SANDBOX/data" "$SANDBOX/config" "$SANDBOX/cache" "$SANDBOX/state" "$SANDBOX/playground"

export XDG_DATA_HOME="$SANDBOX/data"
export XDG_CONFIG_HOME="$SANDBOX/config"
export XDG_CACHE_HOME="$SANDBOX/cache"
export XDG_STATE_HOME="$SANDBOX/state"

echo "kernel sandbox: $SANDBOX (project: $SANDBOX/playground)" >&2
cd "$SANDBOX/playground"
exec bun run --conditions=browser "$ROOT/kernel/packages/opencode/src/index.ts" "$@"
