#!/bin/sh
# Launch the vendored kernel (TUI by default) inside an isolated sandbox.
# WARNING: the TUI lists agents from the v2 endpoint, which the GeoCode assembly
# layer does not reach — it shows upstream's agents, not GeoAgent, and picking one
# fails the prompt. To check the assembly, run `serve` and ask /agent instead
# (docs/KERNEL.md §4.2).
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

# The sandbox's own boundary (docs/ENVIRONMENT.md):
# 1) strip inherited OPENCODE_* and OTEL_* (this machine may also run real OpenCode —
#    a stray OPENCODE_CONFIG(_DIR)/OPENCODE_DB would silently steer the kernel),
# 2) map every GEOCODE_X to OPENCODE_X, the names the kernel natively reads.
# Rule 2 exists only here: the product has no GEOCODE_* channel, and the Electron shell
# strips without mapping (packages/electron/geocode/kernel-environment.mjs).
for v in $(env | sed -nE 's/^((OPENCODE|OTEL)_[A-Za-z0-9_]*)=.*/\1/p'); do unset "$v"; done
for v in $(env | sed -n 's/^GEOCODE_\([A-Za-z0-9_]*\)=.*/\1/p'); do
  [ "$v" = "KERNEL_HOME" ] && continue # script-own knob, not a kernel flag
  eval "export OPENCODE_$v=\"\$GEOCODE_$v\""
done

echo "kernel sandbox: $SANDBOX (project: $SANDBOX/playground)" >&2

# Run from packages/opencode — its bunfig.toml preloads @opentui/solid's JSX
# plugin, and bun only reads bunfig from the cwd. Anywhere else the TUI's
# Solid .tsx files fall back to the react JSX transform and crash on a missing
# react/jsx-dev-runtime. This mirrors upstream's own dev workflow (`bun dev`).
# The sandbox playground is handed over as the [project] positional instead.
cd "$ROOT/kernel/packages/opencode"
if [ $# -eq 0 ]; then
  exec bun run --conditions=browser src/index.ts "$SANDBOX/playground"
fi
exec bun run --conditions=browser src/index.ts "$@"
