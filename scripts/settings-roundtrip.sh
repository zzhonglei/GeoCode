#!/usr/bin/env bash
# Settings round trip: writes one entry per kernel-facing page through the server functions the
# routes call, then asks the kernel's own loaders whether it would see them. Both halves compute
# their roots independently, which is the thing that has broken before.
#
# Runs twice, because which global config file the shell picks depends on which already exists:
# on a real machine the kernel has seeded one before any setting is saved.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATUS=0

run_scenario() {
  local label="$1" seed="$2"
  local scratch config project
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/geocode-roundtrip.XXXXXX")"
  config="$scratch/config/GeoCode"
  project="$scratch/project"
  mkdir -p "$config" "$project"
  if [ -n "$seed" ]; then
    printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$config/$seed"
  fi

  echo
  echo "== $label =="

  local env_vars=(
    "XDG_CONFIG_HOME=$scratch/config"
    "XDG_DATA_HOME=$scratch/data"
    "XDG_CACHE_HOME=$scratch/cache"
    "XDG_STATE_HOME=$scratch/state"
  )

  env "${env_vars[@]}" bun run "$ROOT_DIR/scripts/roundtrip/write-shell.mjs" \
    "$scratch/wrote.json" "$project" > /dev/null

  if ! env "${env_vars[@]}" bun run "$ROOT_DIR/scripts/roundtrip/read-kernel.ts" "$project" \
    | bun run "$ROOT_DIR/scripts/roundtrip/assert.mjs" "$config" "$scratch/wrote.json"; then
    STATUS=1
  fi

  rm -rf "$scratch"
}

run_scenario "nothing seeded — the shell has to create the global config" ""
run_scenario "kernel seeded geocode.jsonc first — what a real machine looks like" "geocode.jsonc"

echo
if [ "$STATUS" -eq 0 ]; then echo "round trip green"; else echo "round trip RED"; fi
exit "$STATUS"
