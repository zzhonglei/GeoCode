#!/bin/sh
# Run the vendored kernel's own suite and group what failed by cause.
#
# This REPORTS, it does not gate. Two deliberate GeoCode changes — branding the
# on-disk identity, and making GeoAgent the only primary agent — leave a large
# block of upstream tests asserting things we no longer ship. The classifier
# separates that expected block from everything else, so the question after a
# merge is "did the other bucket grow", not "are there failures".
#
# Run it after every upstream merge. A test that moves OUT of the expected
# buckets is the signal worth acting on.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${TMPDIR:-/tmp}/geocode-upstream-tests"
mkdir -p "$OUT"

# Files whose SUBJECT GeoCode removed — no arrangement of them can pass, so they
# are skipped rather than left to fail. Two reasons to skip instead of classify:
# every file costs about a second of startup whether it runs one test or thirty,
# and a permanent block of red hides the one failure that matters.
#
# Each line names what is gone. Restoring any of those capabilities means
# deleting the line with it.
#
# NOT listed on purpose — these still exercise something GeoCode ships, so their
# failures stay visible:
#   tool/registry.test.ts        the registry itself is where the geo tools land
#   plugin/auth-override.test.ts the auth-plugin mechanism, used by the built-ins
#   config/*, skill/*, agent/*   fixtures naming the pre-rename identity, which
#                                the classifier already buckets and counts
EXCLUDE="
test/cli/tui/plugin-add.test.ts
test/cli/tui/plugin-install.test.ts
test/cli/tui/plugin-lifecycle.test.ts
test/cli/tui/plugin-loader-entrypoint.test.ts
test/cli/tui/plugin-loader.test.ts
test/cli/tui/plugin-toggle.test.ts
test/plugin/loader-shared.test.ts
test/plugin/trigger.test.ts
test/plugin/workspace-adapter.test.ts
test/agent/plugin-agent-regression.test.ts
test/share/share-next.test.ts
"
# ^ the first ten: external plugins are not loaded, and the TUI that manages
#   them is not shipped (docs/PATHS.md §7). `trigger` reaches the hook dispatch
#   only through an external plugin, so it has no way in either.
#   share-next: sharing is off by product decision (share/share-next.ts).

echo "== running the vendored suite (several minutes) =="
(
  cd "$ROOT/kernel/packages/opencode"
  pattern=$(printf '%s\n' "$EXCLUDE" | grep -v '^$' | sed 's|[./]|\\&|g' | paste -sd'|' -)
  find test -name '*.test.ts' | grep -Ev "^($pattern)$" | sort > "$OUT/opencode-files.txt"
  xargs bun test < "$OUT/opencode-files.txt" > "$OUT/opencode.txt" 2>&1
) || true
(cd "$ROOT/kernel/packages/core" && bun test > "$OUT/core.txt" 2>&1) || true

echo
echo "skipped $(printf '%s\n' "$EXCLUDE" | grep -cv '^$') files whose subject GeoCode removed"
node "$ROOT/scripts/classify-failures.mjs" "$OUT/core.txt" "$OUT/opencode.txt"
echo
echo "raw output: $OUT"
