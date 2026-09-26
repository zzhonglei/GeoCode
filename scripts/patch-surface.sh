#!/bin/sh
# What our patches cost the next upgrade, for one vendor root: how many
# upstream lines we deleted or rewrote (reported), and whether every patched
# upstream file is found by the marker grep (enforced with --check).
#
# Measures the working tree, not the last commit.
#
# Usage:  ./scripts/patch-surface.sh <kernel|desktop> [--check]
set -e

ROOT="$1"
CHECK="${2:-}"
case "$ROOT" in
  kernel)  BRANCH=kernel-upstream ;;
  desktop) BRANCH=chamber-upstream ;;
  *) echo "usage: $(basename "$0") <kernel|desktop> [--check]" >&2; exit 1 ;;
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

# Tab-separated: paths here contain spaces.
git -c core.quotePath=false diff --name-status "$BRANCH" "$TREE:$ROOT" > "$tmp/surface"
added=$(awk '$1=="A"' "$tmp/surface" | wc -l | tr -d ' ')
modified=$(awk '$1=="M"' "$tmp/surface" | wc -l | tr -d ' ')
deleted=$(awk '$1=="D"' "$tmp/surface" | wc -l | tr -d ' ')

echo "== $ROOT/ vs $BRANCH =="
printf "  own files     %s\n" "$added"
printf "  upstream files patched  %s\n" "$modified"
[ "$deleted" -gt 0 ] && printf "  upstream files deleted  %s\n" "$deleted"
echo

# bun.lock is the product of `bun install` over the closure, not a patch.
echo "== exposure: upstream lines deleted or rewritten =="
git -c core.quotePath=false diff --numstat "$BRANCH" "$TREE:$ROOT" \
  | awk -F'\t' '$1 ~ /^[0-9]+$/ && $3 !~ /(^|\/)bun\.lock$/ && $2 > 0 { print $2, $3 }' \
  | LC_ALL=C sort -rn > "$tmp/exposure"

total=$(awk '{s+=$1} END {print s+0}' "$tmp/exposure")
files=$(wc -l < "$tmp/exposure" | tr -d ' ')
printf "  %s lines across %s files (bun.lock excluded)\n" "$total" "$files"
if [ "$files" -gt 0 ]; then
  echo
  awk '{printf "    %5d  %s\n", $1, $2}' "$tmp/exposure" | head -12
  [ "$files" -gt 12 ] && printf "    ... %s more\n" "$((files - 12))"
fi
echo

echo "== auditability =="
awk -F'\t' '$1=="M" {print $2}' "$tmp/surface" | LC_ALL=C sort > "$tmp/patched"
grep -rlE --exclude-dir=node_modules '// GeoCode:|--- GeoCode|"GeoCode: ' "$ROOT" 2>/dev/null \
  | sed "s|^$ROOT/||" | LC_ALL=C sort > "$tmp/marked"
# `comm` collates with the locale, so it must agree with the `sort` above.
unmarked=$(LC_ALL=C comm -23 "$tmp/patched" "$tmp/marked")
n=$(printf '%s' "$unmarked" | grep -c . || true)
printf "  patched files carrying a marker  %s / %s\n" "$((modified - n))" "$modified"
if [ "$n" -gt 0 ]; then
  echo "  changed but not locatable by the grep:"
  echo "$unmarked" | sed 's/^/    /'
  echo "  (.txt prompts, JSON, the lock file, translation dictionaries and image assets cannot carry markers — those are expected here)"
fi

# Named one extension at a time, so a new kind reddens once and somebody decides
# whether it can carry a marker. SVG is absent on purpose: XML takes a comment.
offending=$(printf '%s\n' "$unmarked" | grep -vE '(^|/)bun\.lock$|\.json$|\.txt$|\.png$|\.icns$|\.ico$|\.car$|^packages/ui/src/lib/i18n/messages/[^/]+\.ts$' | grep . || true)
if [ "$CHECK" = "--check" ] && [ -n "$offending" ]; then
  echo
  echo "refuse: patched upstream files without a marker:" >&2
  echo "$offending" | sed 's/^/    /' >&2
  exit 1
fi
