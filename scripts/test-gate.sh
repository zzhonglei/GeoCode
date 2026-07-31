#!/bin/sh
# The suite that must be green: GeoCode's own code, plus the tripwires that
# catch an upstream merge undoing one of our injections.
#
# Deliberately NOT the vendored kernel's full suite. That suite asserts
# upstream's identity and upstream's agent line-up, both of which GeoCode
# changed on purpose — roughly ninety of its tests fail by design, which leaves
# it unable to tell a real regression from the expected noise. Running it is
# still worth doing after a merge; see scripts/test-upstream.sh, which reports
# rather than gates.
#
# Zero patch surface inside kernel/: this file lives outside the vendored tree
# and names test paths rather than editing upstream's package.json.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== typecheck =="
(cd "$ROOT/kernel/packages/opencode" && bun run typecheck)

echo
echo "== geo kernel (opencode) =="
(cd "$ROOT/kernel/packages/opencode" && bun test \
  test/geo/ \
  test/server/geo-content-limit.test.ts \
  test/server/geo-routes-mounted.test.ts \
  test/server/geo-shutdown-sweep.test.ts \
  test/snapshot/geo-exclude.test.ts \
  test/event-manifest.test.ts \
  test/geocode-project-config.test.ts)

echo
echo "== geo kernel (core) =="
(cd "$ROOT/kernel/packages/core" && bun test \
  test/geo-extensions.test.ts \
  test/geo-watcher-ignore.test.ts \
  test/geocode-brand.test.ts)

echo
echo "gate green"
