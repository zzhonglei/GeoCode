#!/bin/sh
# The suite that must be green: GeoCode's own code, plus the tripwires that
# catch an upstream merge undoing one of our injections.
#
# Deliberately NOT the vendored kernel's full suite. That suite asserts
# upstream's identity and upstream's agent line-up, both of which GeoCode
# changed on purpose, so a large permanent block of it fails and a plain pass
# or fail says nothing about whether anything regressed. Upstream's suites
# are not ours to maintain (docs/CONVENTIONS.md §7).
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

# GeoCode: the gate itself must not touch user data. 2026-09-05 caught a control case writing a
# fake process record into the real managed-opencode directory, which the shell reads at startup
# to kill pids; nothing was watching, and the same class of mistake in a suite that builds real
# git repositories or config layers would land in the developer's own GeoCode roots. The detector
# already watches the other products' directories, so this only adds ours and wraps the run.
GATE_WRITES_SNAPSHOT="${TMPDIR:-/tmp}/geocode-gate-writes"
GATE_WRITES_ROOTS="$HOME/.config/GeoCode $HOME/.local/share/GeoCode $HOME/.cache/GeoCode $HOME/.local/state/GeoCode"
export FOREIGN_WRITES_SNAPSHOT="$GATE_WRITES_SNAPSHOT"
export FOREIGN_WRITES_EXTRA_ROOTS="$GATE_WRITES_ROOTS"

# Reported through an EXIT trap rather than at the end, or a suite that goes red takes the answer
# with it — and a suite that writes is exactly the kind that also fails.
report_gate_writes() {
  status=$?
  trap - EXIT
  echo
  echo "== write detection: the gate must not touch user data =="
  "$ROOT/scripts/foreign-writes.sh" after || status=1
  exit $status
}
"$ROOT/scripts/foreign-writes.sh" before > /dev/null
trap report_gate_writes EXIT

# The WHOLE workspace, not just packages/opencode — which is all this used to
# check, and the gap was invisible from inside the gate.
#
# `bun test` executes TypeScript by stripping types, never by checking them, so
# a type error is not something the suites below can fail on. That left every
# package except one with no type checking anywhere in the gate. Measured on
# 2026-08-20: packages/core carried a real error (geocode-brand.test.ts, a
# literal tuple whose elements no longer matched `Brand.projectDir` after the
# object widened it) that had been sitting there green, and it only surfaced
# because a full `turbo typecheck` was run by hand for an unrelated reason.
#
# core is not a corner of the tree: Brand, Global.Path, FSUtil and the geodata
# snapshot-exclusion list all live in it. Cost is not the reason to keep the
# narrow version either — turbo caches per package, so the full pass is about
# eleven seconds warm.
echo "== typecheck =="
(cd "$ROOT/kernel" && bun run typecheck)
# GeoCode: the renderer too. It was absent until 2026-09-07, and a duplicate import shipped
# through the gate green because `bun test` does not typecheck. `packages/web` and
# `packages/electron` are JavaScript, so this is the whole of the desktop side.
(cd "$ROOT/desktop/packages/ui" && bun run build)

echo
echo "== geo kernel (opencode) =="
(cd "$ROOT/kernel/packages/opencode" && bun test $TIMEOUT \
  test/geo/ \
  test/server/geo-content-limit.test.ts \
  test/snapshot/geo-exclude.test.ts \
  test/event-manifest.test.ts \
  test/geocode-project-config.test.ts \
  test/geocode-compaction-prompt.test.ts \
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
  test/geocode-trusted-plugin.test.ts \
  test/geocode-osmfetch.test.ts \
  test/geocode-read-handoff.test.ts \
  test/geocode-global-dispose.test.ts)

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
echo "== desktop shell (electron) =="
# Everything under geocode/ is ours: the Electron identity, the kernel host and its
# environment boundary, the kernel paths, and the shell data root. `bun test` rather than
# `node --test` — they import from `bun:test`, which node's ESM loader rejects outright.
(cd "$ROOT/desktop/packages/electron" && bun test geocode/)

echo
echo "== desktop shell (web server) =="
# Named file by file rather than running the package's suite, for the same reason the
# kernel's suite is not a gate: it is upstream's, and parts of it assert what GeoCode
# changed on purpose.
(cd "$ROOT/desktop/packages/web" && bun run vitest run \
  server/geocode/ \
  server/shell-data-root.test.js \
  server/lib/quota/providers/claude-disabled.test.js)

echo
echo "== desktop shell (renderer) =="
# `packages/ui` was absent from this gate entirely until 2026-08-30, and the gap was invisible
# from inside it: the renderer composes two storage paths of its own, and when the shell data
# root moved they were left naming OpenChamber's directory with nothing to notice. Its own
# suite is upstream's, so what runs here is ours, named the way every other section names
# its own files.
#
# The ui tripwire pins the renderer's value; the cross-package assertion that the renderer and
# the injection agree lives in the electron section above, because that package has no `tsc`
# pass and can import a `.ts` module directly.
(cd "$ROOT/desktop/packages/ui" && bun test src/geocode/)

echo
echo "== settings round trip (shell writes, kernel reads) =="
# The one thing neither package's suite can answer, because the two halves are separate install
# roots: a setting saved through the server functions the routes call, read back by the kernel's
# own loaders. Both halves compute their roots independently, which is what has broken before.
# Proven to fail: pointing the shell's config root back at OpenCode turns every page red, and
# renaming just the skill directory turns only skills red.
"$ROOT/scripts/settings-roundtrip.sh"

echo
echo "== patch auditability =="
# Every patched upstream file must be findable by the marker grep (docs/CONVENTIONS.md §5).
# Kinds that cannot carry a marker pass; translation dictionaries are bound by
# ui/src/geocode/locale-*.test.ts instead.
"$ROOT/scripts/patch-surface.sh" kernel --check
"$ROOT/scripts/patch-surface.sh" desktop --check

echo
echo "gate green"
