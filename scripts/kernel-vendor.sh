#!/bin/sh
# Lay one upstream release down on kernel-upstream, reproducibly.
#
# The merge itself is ordinary git: main and kernel-upstream share a real
# merge-base, so a file we never touched takes the upstream side automatically,
# exactly as in any fork (measured: 805 upstream files changed between v1.18.4
# and v1.18.18, 3 of them conflicted).
#
# What is NOT ordinary is where kernel-upstream's content comes from. Upstream
# ships 32 packages and we carry 15, so the branch cannot be upstream's history
# — it is a sequence of hand-picked snapshots, and the merge-base is therefore
# only as faithful as the picking was. That is this environment's single
# failure mode, and it is silent: drop a file from the selection and git reads
# it as "upstream deleted this", removing it from main with no conflict at all.
#
# So the selection lives in scripts/kernel-manifest.txt and this script applies
# it. It stops at `git add` — the commit is the maintainer's (docs/CONVENTIONS.md §4).
#
# Usage:  git checkout kernel-upstream && ./scripts/kernel-vendor.sh v1.18.18
#
# To avoid switching the main working tree, run it from a scratch one instead:
#   git worktree add ../geocode-vendor kernel-upstream
set -e

TAG="$1"
if [ -z "$TAG" ]; then
  echo "usage: $(basename "$0") <upstream-tag>   e.g. $(basename "$0") v1.18.18" >&2
  exit 1
fi

REPO="anomalyco/opencode"

# The manifest travels with the script; the vendoring happens in whatever
# working tree the caller stands in. They are deliberately two different
# checkouts: kernel-upstream carries no scripts/ directory, so running this
# from a scratch worktree (see above) has to read the manifest from the
# checkout that does carry it.
MANIFEST=$(cd "$(dirname "$0")" && pwd)/kernel-manifest.txt
cd "$(git rev-parse --show-toplevel)"

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "kernel-upstream" ]; then
  echo "refuse: this writes a pristine upstream tree, which belongs only on" >&2
  echo "        kernel-upstream. Currently on '$branch'." >&2
  exit 1
fi

# This script deletes every tracked file before refilling, so anything
# uncommitted would go with them.
if [ -n "$(git status --porcelain)" ]; then
  echo "refuse: working tree is not clean." >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/src"

echo "== fetching $REPO @ $TAG =="
gh api "repos/$REPO/tarball/$TAG" > "$tmp/upstream.tar.gz"
tar -xzf "$tmp/upstream.tar.gz" -C "$tmp/src" --strip-components=1

grep -v '^[[:space:]]*#' "$MANIFEST" | grep -v '^[[:space:]]*$' > "$tmp/manifest"

# The expected file set, derived from the manifest against THIS tag. A path the
# tag does not have is a hard stop rather than a warning: it means upstream
# moved or dropped something the closure names, and continuing would vendor a
# closure quietly missing a piece.
echo "== selecting per manifest =="
: > "$tmp/expected"
while IFS= read -r item; do
  if [ -d "$tmp/src/$item" ]; then
    (cd "$tmp/src" && find "$item" -type f) >> "$tmp/expected"
  elif [ -f "$tmp/src/$item" ]; then
    echo "$item" >> "$tmp/expected"
  else
    echo "refuse: manifest names a path $TAG does not have: $item" >&2
    exit 1
  fi
done < "$tmp/manifest"
LC_ALL=C sort -o "$tmp/expected" "$tmp/expected"

echo "== replacing tracked tree =="
git rm -rq --ignore-unmatch . >/dev/null
while IFS= read -r item; do
  rm -rf "$item"
  parent=$(dirname "$item")
  [ "$parent" = "." ] || mkdir -p "$parent"
  cp -R "$tmp/src/$item" "$item"
done < "$tmp/manifest"

# --force is the whole point of this line. The closure carries upstream's own
# .gitignore, and upstream force-tracks several files that .gitignore matches.
# Without --force they land on disk and never reach the commit, which is
# precisely how packages/opencode/script/build-node.ts was lost on the first
# v1.18.4 import and only found later.
git add --force -A .
git ls-files | LC_ALL=C sort > "$tmp/actual"

# The reconciliation. Not a formality: it is the only thing standing between a
# mis-picked closure and a merge that silently deletes files from main.
if ! diff -q "$tmp/expected" "$tmp/actual" >/dev/null 2>&1; then
  echo >&2
  echo "RECONCILE FAILED — do not commit this." >&2
  echo "-- selected but not staged (swallowed, most likely by .gitignore):" >&2
  comm -23 "$tmp/expected" "$tmp/actual" >&2
  echo "-- staged but not selected (stray):" >&2
  comm -13 "$tmp/expected" "$tmp/actual" >&2
  exit 1
fi

count=$(wc -l < "$tmp/actual" | tr -d ' ')
echo "reconciled: $count files, selection and index agree"
echo

if git diff --cached --quiet HEAD; then
  echo "no change against HEAD — $TAG reproduces the current kernel-upstream exactly."
else
  git diff --cached --stat HEAD | tail -1
  echo
  echo "review the diff, then commit it yourself:"
  echo "  git commit -m \"chore: import opencode $TAG kernel closure (pristine subset)\""
fi
