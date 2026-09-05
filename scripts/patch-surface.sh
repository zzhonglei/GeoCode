#!/bin/sh
# What our patches cost the next upgrade, for one vendor root.
#
# docs/KERNEL.md §4.3 settles what makes a patch expensive: "how many lines of
# still-maintained upstream code it occupies". That splits in two, and only one
# half is ours to control:
#
#   exposure  = upstream lines we deleted or rewrote   <- measured here
#   hit rate  = whether upstream then touches them     <- not ours to decide
#
# Measured on the kernel's v1.18.4 -> v1.18.18 upgrade: cli/cmd/mcp.ts had 4
# lines of exposure and upstream changed the file 3 times, yet merged clean;
# plugin/index.ts had the same 4 lines and conflicted, because upstream changed
# exactly those. Frequency predicts nothing on its own. Exposure is the number
# to drive down — session/system.ts went from the tree's most expensive patch to
# zero deleted lines by shielding with an early return instead of deleting.
#
# Exposure reports; it does not gate. There is no threshold worth hardcoding — the
# number to watch is whether it grows between upgrades. Auditability does gate,
# with --check: a patched upstream file the marker grep cannot find is one a
# merge has to discover by reading (docs/CONVENTIONS.md §5). Only the kinds that
# cannot carry a marker pass — JSON, the lock file, .txt prompts, and the
# translation dictionaries, which are bound by tests instead.
#
# Measures the working tree, not the last commit, so the gate sees an edit
# before it is committed.
#
# Usage:  ./scripts/patch-surface.sh kernel [--check]
#         ./scripts/patch-surface.sh desktop [--check]
set -e

ROOT="$1"
CHECK="${2:-}"
case "$ROOT" in
  kernel)  BRANCH=kernel-upstream ;;
  desktop) BRANCH=chamber-upstream ;;
  *) echo "usage: $(basename "$0") <kernel|desktop>" >&2; exit 1 ;;
esac
cd "$(git rev-parse --show-toplevel)"

if ! git rev-parse --verify -q "$BRANCH" >/dev/null; then
  echo "refuse: no branch '$BRANCH' — the pristine side of $ROOT/ is missing." >&2
  exit 1
fi

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# `stash create` writes the working tree as a commit without touching the index,
# the stash list, or the files; empty when the tree is clean.
TREE=$(git stash create 2>/dev/null || true)
TREE="${TREE:-HEAD}"

git diff --name-status "$BRANCH" "$TREE:$ROOT" > "$tmp/surface"
added=$(awk '$1=="A"' "$tmp/surface" | wc -l | tr -d ' ')
modified=$(awk '$1=="M"' "$tmp/surface" | wc -l | tr -d ' ')
deleted=$(awk '$1=="D"' "$tmp/surface" | wc -l | tr -d ' ')

echo "== $ROOT/ vs $BRANCH =="
printf "  own files     %s\n" "$added"
printf "  upstream files patched  %s\n" "$modified"
[ "$deleted" -gt 0 ] && printf "  upstream files deleted  %s   <- deletion is form 4 by definition\n" "$deleted"
echo

# Exposure. bun.lock is excluded by name: it is not a patch but the product of
# `bun install` over the closure, and it differs from upstream by thousands of
# lines that cost nothing (docs/CONVENTIONS.md §5).
echo "== exposure: upstream lines deleted or rewritten =="
git diff --numstat "$BRANCH" "$TREE:$ROOT" \
  | awk '$1 ~ /^[0-9]+$/ && $3 != "bun.lock" && $2 > 0 { print $2, $3 }' \
  | sort -rn > "$tmp/exposure"

total=$(awk '{s+=$1} END {print s+0}' "$tmp/exposure")
files=$(wc -l < "$tmp/exposure" | tr -d ' ')
printf "  %s lines across %s files (bun.lock excluded)\n" "$total" "$files"
if [ "$files" -gt 0 ]; then
  echo
  awk '{printf "    %5d  %s\n", $1, $2}' "$tmp/exposure" | head -12
  [ "$files" -gt 12 ] && printf "    ... %s more\n" "$((files - 12))"
fi
echo

# Auditability. The authoritative list of patches is this grep, not a hand-kept
# inventory (docs/CONVENTIONS.md §5): a hand-kept one drifts, and once called
# six healthy patches debts, one of which did not exist.
echo "== auditability =="
awk '$1=="M" {print $2}' "$tmp/surface" | LC_ALL=C sort > "$tmp/patched"
grep -rlE '// GeoCode:|--- GeoCode|"GeoCode: ' "$ROOT" 2>/dev/null \
  | sed "s|^$ROOT/||" | LC_ALL=C sort > "$tmp/marked"
unmarked=$(comm -23 "$tmp/patched" "$tmp/marked")
n=$(printf '%s' "$unmarked" | grep -c . || true)
printf "  patched files carrying a marker  %s / %s\n" "$((modified - n))" "$modified"
if [ "$n" -gt 0 ]; then
  echo "  changed but not locatable by the grep:"
  echo "$unmarked" | sed 's/^/    /'
  echo "  (.txt prompts, JSON, the lock file and translation dictionaries cannot carry markers — those are expected here)"
fi

offending=$(printf '%s\n' "$unmarked" | grep -vE '(^|/)bun\.lock$|\.json$|\.txt$|^packages/ui/src/lib/i18n/messages/[^/]+\.ts$' | grep . || true)
if [ "$CHECK" = "--check" ] && [ -n "$offending" ]; then
  echo
  echo "refuse: patched upstream files without a marker (docs/CONVENTIONS.md §5):" >&2
  echo "$offending" | sed 's/^/    /' >&2
  exit 1
fi
