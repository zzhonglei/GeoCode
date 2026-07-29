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

echo "== running the vendored suite (several minutes) =="
(cd "$ROOT/kernel/packages/opencode" && bun test > "$OUT/opencode.txt" 2>&1) || true
(cd "$ROOT/kernel/packages/core" && bun test > "$OUT/core.txt" 2>&1) || true

echo
node "$ROOT/scripts/classify-failures.mjs" "$OUT/core.txt" "$OUT/opencode.txt"
echo
echo "raw output: $OUT"
