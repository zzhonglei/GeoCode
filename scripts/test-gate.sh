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

# The same bound the package's own `test` script uses. Without it bun applies
# its 5s default, which is tighter than anything here was written against: the
# permission tests compile the whole layer graph and take about a second each,
# so a machine busy with something else turns one of them red for no reason —
# observed once, and a gate that cries wolf is a gate people stop reading.
#
# Nothing is left unguarded by widening it. The tests that can genuinely hang
# — a permission ask with no user to answer it — carry their own
# `Effect.timeout` inside, which is where a hang has a name; this one is only
# the backstop behind those.
TIMEOUT="--timeout 30000"

echo "== typecheck =="
(cd "$ROOT/kernel/packages/opencode" && bun run typecheck)

echo
echo "== geo kernel (opencode) =="
(cd "$ROOT/kernel/packages/opencode" && bun test $TIMEOUT \
  test/geo/ \
  test/server/geo-content-limit.test.ts \
  test/server/geo-shutdown-sweep.test.ts \
  test/snapshot/geo-exclude.test.ts \
  test/event-manifest.test.ts \
  test/geocode-project-config.test.ts \
  test/geocode-truncation-hint.test.ts \
  test/geocode-geo-read.test.ts \
  test/geocode-qgis-doc.test.ts \
  test/geocode-qgis-run.test.ts \
  test/geocode-gee-run.test.ts \
  test/geocode-osm-search.test.ts \
  test/geocode-osm-probe.test.ts \
  test/geocode-osm-objects.test.ts \
  test/geocode-osm-report.test.ts \
  test/geocode-osm-features.test.ts \
  test/geocode-geo-permissions.test.ts \
  test/geocode-osmfetch.test.ts \
  test/geocode-read-handoff.test.ts)

echo
echo "== shielding tripwires living inside upstream's own test files =="
# The third shielded item (Claude Code's CLAUDE.md and .claude/skills, KERNEL.md
# §6) is the one whose tripwires could not live in a geocode-*.test.ts: the flag
# defaults are read in upstream's own suites and nowhere else. They were written
# and then never run — reverting the two defaults turns fourteen assertions red
# across these files while this gate stayed green, which is the exact failure
# the gate exists to prevent.
#
# The first two files are green whole. skill.test.ts is not: six of its cases
# assert the pre-rename `.opencode/skill` path and fail by design, so the
# GeoCode-named case is selected out of it by name rather than the file being
# dragged in with its expected red.
#
# system.test.ts is here for a different shielded thing — the prompt selector
# (KERNEL.md §5.2). Its GeoCode case is the only RUNTIME check that every model
# still resolves to the one base prompt; geocode-brand.test.ts reads the source
# of system.ts, which is a different question.
(cd "$ROOT/kernel/packages/opencode" && bun test $TIMEOUT \
  test/effect/runtime-flags.test.ts \
  test/session/instruction.test.ts \
  test/session/system.test.ts)
(cd "$ROOT/kernel/packages/opencode" && bun test $TIMEOUT -t "GeoCode:" test/skill/skill.test.ts)

echo
echo "== geo kernel (core) =="
(cd "$ROOT/kernel/packages/core" && bun test $TIMEOUT \
  test/geo-extensions.test.ts \
  test/geo-watcher-ignore.test.ts \
  test/geocode-brand.test.ts \
  test/geocode-compaction-template.test.ts)

echo
echo "gate green"
