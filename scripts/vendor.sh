#!/bin/sh
# Lay one upstream release down on its pristine branch, per the closure manifest.
# Stops at `git add`; the commit is the maintainer's.
#
# Usage:  ./scripts/vendor.sh <kernel|chamber> <upstream-tag>
#
# Run it from a scratch worktree on the pristine branch, so the manifest is read
# from this checkout while the tree is written there:
#   git worktree add ../geocode-vendor kernel-upstream
#   (cd ../geocode-vendor && /path/to/geocode/scripts/vendor.sh kernel v2.0.18)
set -e

SIDE="$1"
TAG="$2"
case "$SIDE" in
  kernel)  REPO=anomalyco/opencode;       BRANCH=kernel-upstream ;;
  chamber) REPO=openchamber/openchamber;  BRANCH=chamber-upstream ;;
  *) SIDE= ;;
esac
if [ -z "$SIDE" ] || [ -z "$TAG" ]; then
  echo "usage: $(basename "$0") <kernel|chamber> <upstream-tag>" >&2
  exit 1
fi

MANIFEST=$(cd "$(dirname "$0")" && pwd)/$SIDE-manifest.txt
cd "$(git rev-parse --show-toplevel)"

# symbolic-ref, not rev-parse --abbrev-ref: the first import runs on an unborn
# branch, where rev-parse answers "HEAD".
branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "(detached)")
if [ "$branch" != "$BRANCH" ]; then
  echo "refuse: this writes a pristine upstream tree, which belongs only on" >&2
  echo "        $BRANCH. Currently on '$branch'." >&2
  exit 1
fi

# Every tracked file is deleted before refilling.
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
grep '^-' "$tmp/all" | sed 's/^-//' > "$tmp/dropped" || true
grep -v '^[!-]' "$tmp/all" > "$tmp/manifest"

# FILENAME, not NR==FNR: the latter misreads an empty first file.
drop() {
  awk -F/ 'FILENAME==ARGV[1] {d[$0]=1; next} !($NF in d)' "$tmp/dropped" "$1"
}

LC_ALL=C sort "$tmp/manifest" > "$tmp/sel.sorted"
LC_ALL=C sort "$tmp/excluded" > "$tmp/exc.sorted"
overlap=$(LC_ALL=C comm -12 "$tmp/sel.sorted" "$tmp/exc.sorted")
if [ -n "$overlap" ]; then
  echo "refuse: manifest both selects and excludes:" >&2
  echo "$overlap" >&2
  exit 1
fi
overlap=$(drop "$tmp/manifest" | LC_ALL=C sort | LC_ALL=C comm -13 - "$tmp/sel.sorted")
if [ -n "$overlap" ]; then
  echo "refuse: manifest selects a file whose name it drops:" >&2
  echo "$overlap" >&2
  exit 1
fi

# Every upstream entry must be either selected or declared with `!`, so that
# "we decided against it" differs from "nobody has looked at it yet".
declared() {
  awk -v t="$1" '$0==t || index($0, t "/")==1 {f=1} END{exit !f}' "$tmp/manifest" && return 0
  awk -v t="$1" '$0==t {f=1} END{exit !f}' "$tmp/excluded" && return 0
  awk -v t="${1##*/}" '$0==t {f=1} END{exit !f}' "$tmp/dropped" && return 0
  return 1
}

# A directory reached only by deeper lines says nothing about a sibling added
# later, so its children are checked one level further down.
named_outright() {
  awk -v t="$1" '$0==t {f=1} END{exit !f}' "$tmp/manifest" && return 0
  awk -v t="$1" '$0==t {f=1} END{exit !f}' "$tmp/excluded" && return 0
  return 1
}
check_entry() {
  if ! declared "$1"; then
    echo "$1" >> "$tmp/undeclared"
    return 0
  fi
  if named_outright "$1"; then
    return 0
  fi
  if [ ! -d "$tmp/src/$1" ]; then
    return 0
  fi
  for child in $(cd "$tmp/src/$1" && ls -A); do
    check_entry "$1/$child"
  done
  return 0
}
: > "$tmp/undeclared"
for top in $(cd "$tmp/src" && ls -A); do
  check_entry "$top"
done
if [ -s "$tmp/undeclared" ]; then
  echo
  echo "NOTE — $TAG has entries the manifest does not mention:" >&2
  sed 's/^/    /' "$tmp/undeclared" >&2
  echo "  Decide each one: add it to the selection, or declare it with a leading !." >&2
  echo
fi

# A named path this tag lacks is a hard stop: continuing would vendor a closure
# quietly missing a piece.
echo "== selecting per manifest =="
: > "$tmp/expected"
while IFS= read -r item; do
  if [ -d "$tmp/src/$item" ]; then
    (cd "$tmp/src" && find "$item" \( -type f -o -type l \)) >> "$tmp/expected"
  elif [ -f "$tmp/src/$item" ] || [ -L "$tmp/src/$item" ]; then
    echo "$item" >> "$tmp/expected"
  else
    echo "refuse: manifest names a path $TAG does not have: $item" >&2
    exit 1
  fi
done < "$tmp/manifest"
drop "$tmp/expected" | LC_ALL=C sort > "$tmp/expected.kept"
mv "$tmp/expected.kept" "$tmp/expected"

echo "== replacing tracked tree =="
# clean as well as rm: ignored leftovers such as a Finder .DS_Store would be
# picked up by the forced add below.
git rm -rq --ignore-unmatch . >/dev/null
git clean -qfdx
while IFS= read -r item; do
  rm -rf "$item"
  parent=$(dirname "$item")
  [ "$parent" = "." ] || mkdir -p "$parent"
  cp -R "$tmp/src/$item" "$item"
done < "$tmp/manifest"
while IFS= read -r name; do
  while IFS= read -r item; do
    if [ -d "$item" ]; then
      find "$item" \( -type f -o -type l \) -name "$name" -exec rm -f {} +
    fi
  done < "$tmp/manifest"
done < "$tmp/dropped"

# --force: upstream force-tracks files its own .gitignore matches.
git add --force -A .
git ls-files | LC_ALL=C sort > "$tmp/actual"

if ! diff -q "$tmp/expected" "$tmp/actual" >/dev/null 2>&1; then
  echo >&2
  echo "RECONCILE FAILED — do not commit this." >&2
  echo "-- selected but not staged (swallowed, most likely by .gitignore):" >&2
  LC_ALL=C comm -23 "$tmp/expected" "$tmp/actual" >&2
  echo "-- staged but not selected (stray):" >&2
  LC_ALL=C comm -13 "$tmp/expected" "$tmp/actual" >&2
  exit 1
fi

count=$(wc -l < "$tmp/actual" | tr -d ' ')
echo "reconciled: $count files, selection and index agree"
echo

name=$(basename "$REPO")
message="chore: import $name $TAG closure (pristine subset)"
if ! git rev-parse --verify -q HEAD >/dev/null; then
  echo "orphan branch, no HEAD yet — this will be the root commit."
  echo
  echo "review the tree, then commit it yourself:"
  echo "  git commit -m \"$message\""
elif git diff --cached --quiet HEAD; then
  echo "no change against HEAD — $TAG reproduces the current $BRANCH exactly."
else
  git diff --cached --stat HEAD | tail -1
  echo
  echo "review the diff, then commit it yourself:"
  echo "  git commit -m \"$message\""
fi
