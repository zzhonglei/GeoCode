#!/bin/sh
# Lay one upstream release down on chamber-upstream, reproducibly.
#
# The merge itself is ordinary git: main and chamber-upstream share a real
# merge-base, so a file we never touched takes the upstream side automatically,
# exactly as in any fork.
#
# What is NOT ordinary is where chamber-upstream's content comes from. It is
# not upstream's history — it is a sequence of hand-picked snapshots, and the
# merge-base is therefore only as faithful as the picking was. That is this
# environment's single failure mode, and it is silent: drop a path from the
# selection and git reads it as "upstream deleted this", removing it from main
# with no conflict at all.
#
# So the selection lives in scripts/chamber-manifest.txt and this script applies
# it. It stops at `git add` — the commit is the maintainer's (docs/CONVENTIONS.md §4).
#
# Usage:  git checkout chamber-upstream && ./scripts/chamber-vendor.sh v1.18.4
#
# To avoid switching the main working tree, run it from a scratch one instead:
#   git worktree add ../geocode-chamber chamber-upstream
set -e

TAG="$1"
if [ -z "$TAG" ]; then
  echo "usage: $(basename "$0") <upstream-tag>   e.g. $(basename "$0") v1.18.4" >&2
  exit 1
fi

REPO="openchamber/openchamber"

# The manifest travels with the script; the vendoring happens in whatever
# working tree the caller stands in. They are deliberately two different
# checkouts: chamber-upstream carries no scripts/ directory of ours, so running
# this from a scratch worktree (see above) has to read the manifest from the
# checkout that does carry it.
MANIFEST=$(cd "$(dirname "$0")" && pwd)/chamber-manifest.txt
cd "$(git rev-parse --show-toplevel)"

# symbolic-ref, not rev-parse --abbrev-ref: on an unborn branch — which is how
# this one starts — rev-parse answers "HEAD" and the check below would reject
# the very case it is meant to allow. A detached HEAD has no symbolic ref and
# falls through to the refusal, which is correct.
branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "(detached)")
if [ "$branch" != "chamber-upstream" ]; then
  echo "refuse: this writes a pristine upstream tree, which belongs only on" >&2
  echo "        chamber-upstream. Currently on '$branch'." >&2
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

grep -v '^[[:space:]]*#' "$MANIFEST" | grep -v '^[[:space:]]*$' > "$tmp/all"
grep '^!' "$tmp/all" | sed 's/^!//' > "$tmp/excluded" || true
grep -v '^!' "$tmp/all" > "$tmp/manifest"

# A path cannot be both taken and declared-absent; that would mean two lines of
# the closure disagree, and whichever the code happens to read first would win.
LC_ALL=C sort "$tmp/manifest" > "$tmp/sel.sorted"
LC_ALL=C sort "$tmp/excluded" > "$tmp/exc.sorted"
overlap=$(comm -12 "$tmp/sel.sorted" "$tmp/exc.sorted")
if [ -n "$overlap" ]; then
  echo "refuse: manifest both selects and excludes:" >&2
  echo "$overlap" >&2
  exit 1
fi

# A whitelist's failure mode is silence: upstream adds a top-level entry, no
# line names it, and it is dropped with nothing said. The `!` declarations exist
# so this check can tell "we decided against it" from "nobody has looked at it
# yet". Reported, not refused — a new entry is news, not an error.
declared() {
  awk -v t="$1" '$0==t || index($0, t "/")==1 {f=1} END{exit !f}' "$tmp/manifest" && return 0
  awk -v t="$1" '$0==t {f=1} END{exit !f}' "$tmp/excluded" && return 0
  return 1
}
: > "$tmp/undeclared"
for top in $(cd "$tmp/src" && ls -A); do
  declared "$top" || echo "$top" >> "$tmp/undeclared"
done
if [ -s "$tmp/undeclared" ]; then
  echo
  echo "NOTE — $TAG has top-level entries the manifest does not mention:" >&2
  sed 's/^/    /' "$tmp/undeclared" >&2
  echo "  Decide each one: add it to the selection, or declare it with a leading !." >&2
  echo
fi

# The expected file set, derived from the manifest against THIS tag. A path the
# tag does not have is a hard stop rather than a warning: it means upstream
# moved or dropped something the closure names, and continuing would vendor a
# closure quietly missing a piece.
echo "== selecting per manifest =="
: > "$tmp/expected"
while IFS= read -r item; do
  if [ -d "$tmp/src/$item" ]; then
    # -type l as well as -type f: upstream force-tracks symlinks (CLAUDE.md and
    # the six under .claude/skills at v1.18.4). Those are excluded, but a
    # symlink appearing inside a selected directory would otherwise be staged
    # and not expected, failing the reconciliation for no real reason.
    (cd "$tmp/src" && find "$item" \( -type f -o -type l \)) >> "$tmp/expected"
  elif [ -f "$tmp/src/$item" ] || [ -L "$tmp/src/$item" ]; then
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
# .gitignore, and upstream force-tracks files that .gitignore matches (.env and
# the .claude/skills symlinks at v1.18.4). Without --force such a file lands on
# disk and never reaches the commit — precisely how opencode's build-node.ts was
# lost on the kernel's first import and only found later.
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

# HEAD does not exist on the first commit of a fresh orphan branch, which is
# exactly how this branch begins: a sequence of snapshots with no upstream
# history behind it (docs/DESKTOP.md §9.2).
if ! git rev-parse --verify -q HEAD >/dev/null; then
  echo "orphan branch, no HEAD yet — this will be the root commit."
  echo
  echo "review the tree, then commit it yourself:"
  echo "  git commit -m \"chore: import openchamber $TAG desktop closure (pristine subset)\""
elif git diff --cached --quiet HEAD; then
  echo "no change against HEAD — $TAG reproduces the current chamber-upstream exactly."
else
  git diff --cached --stat HEAD | tail -1
  echo
  echo "review the diff, then commit it yourself:"
  echo "  git commit -m \"chore: import openchamber $TAG desktop closure (pristine subset)\""
fi
