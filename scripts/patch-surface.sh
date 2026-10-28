#!/bin/sh
# The changes against the pristine branch for one vendor root: which files,
# how many upstream lines were deleted or rewritten, and which patched upstream
# files carry a GeoCode marker. Markers are optional, so this only reports.
# With --hunks, every patch in turn: where, how many lines it adds and removes,
# and whether a marker explains it.
#
# Measures the working tree, not the last commit.
#
# Usage:  ./scripts/patch-surface.sh <kernel|desktop> [--hunks]
set -e

ROOT="$1"
HUNKS="${2:-}"
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

echo "== markers =="
# Files that cannot hold a comment, or that are generated: images, icons, JSON, the lockfile.
ASSETS='\.(png|jpe?g|gif|webp|svg|icns|ico|car|json)$|(^|/)bun\.lock$|/AppIcon\.icon/'
awk -F'\t' '$1=="M" {print $2}' "$tmp/surface" | LC_ALL=C sort > "$tmp/patched"
grep -Ev "$ASSETS" "$tmp/patched" > "$tmp/code" || true
assets=$(grep -Ec "$ASSETS" "$tmp/patched" || true)
git grep -l 'GeoCode' "$TREE" -- "$ROOT" | sed "s|^$TREE:$ROOT/||" | LC_ALL=C sort > "$tmp/marked"
# `comm` collates with the locale, so it must agree with the `sort` above.
unmarked=$(LC_ALL=C comm -23 "$tmp/code" "$tmp/marked")
n=$(printf '%s' "$unmarked" | grep -c . || true)
code=$(wc -l < "$tmp/code" | tr -d ' ')
printf "  patched upstream code files carrying a marker  %s / %s\n" "$((code - n))" "$code"
printf "  patched images, icons, JSON and lockfiles, which hold none  %s\n" "$assets"
if [ "$n" -gt 0 ]; then
  echo "  code without a marker (their commit messages should say what they do):"
  echo "$unmarked" | sed 's/^/    /'
fi
if [ "$deleted" -gt 0 ]; then
  echo
  echo "== upstream files deleted =="
  awk -F'\t' '$1=="D" {print "    " $2}' "$tmp/surface"
fi

[ "$HUNKS" = "--hunks" ] || exit 0
echo
# Each patch: the line it starts at in GeoCode's file, lines added and removed, and its marker: one among its own lines,
# the nearest one in the 15 lines above (which may or may not speak for it), or none.
echo "== patches: file:line  +added -removed  marker =="
while IFS= read -r file; do
  git -c core.quotePath=false diff -U0 "$BRANCH" "$TREE:$ROOT" -- "$file" \
    | awk '/^@@/ { if (start) print start, add, del, own; split($3, at, ","); start = substr(at[1], 2); add = 0; del = 0; own = 0; next }
           /^\+\+\+|^---/ { next }
           /^\+/ { add++; if (/GeoCode/) own = 1; next }
           /^-/ { del++ }
           END { if (start) print start, add, del, own }' > "$tmp/hunks"
  git show "$TREE:$ROOT/$file" > "$tmp/new" 2>/dev/null || : > "$tmp/new"
  while read -r start add del own; do
    if [ "$own" = 1 ]; then
      marker=own
    else
      near=$(awk -v s="$start" 'NR >= s - 15 && NR < s && /GeoCode/ { n = NR } END { if (n) print n }' "$tmp/new")
      marker=${near:+"above at $near"}
      marker=${marker:-none}
    fi
    printf "  %s:%s  +%s -%s  %s\n" "$file" "$start" "$add" "$del" "$marker"
  done < "$tmp/hunks"
done < "$tmp/code"
