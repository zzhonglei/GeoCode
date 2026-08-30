#!/bin/sh
# Snapshot the directories GeoCode must never touch, so a run can be checked
# against them. `before` records; `after` reports any file that appeared or
# changed. Ownership, not spelling: this catches a path built from variables,
# a path compiled into a vendored bundle, and a default that defeats a patch —
# none of which a grep for `opencode` can see (docs/DESKTOP.md stage 6).
set -e
# `.claude` is narrowed to the paths GeoCode's code can actually reach. Watching the whole
# directory is useless here: Claude Code itself writes session transcripts and plugin caches
# under it continuously, and that noise would bury a real hit on the first run.
ROOTS="$HOME/.config/opencode $HOME/.local/share/opencode $HOME/.cache/opencode
       $HOME/.opencode $HOME/.config/openchamber $HOME/.agents
       $HOME/.claude/skills $HOME/.claude/ide $HOME/.claude/agents
       $HOME/.claude/commands $HOME/.claude/CLAUDE.md $HOME/.claude/.credentials.json
       ${TMPDIR:-/tmp}/opencode"
SNAP="${FOREIGN_WRITES_SNAPSHOT:-/tmp/geocode-foreign-writes}"

snapshot() {
  for root in $ROOTS; do
    [ -e "$root" ] || continue
    find "$root" -not -path '*/.git/*' -exec stat -f '%N %m %z' {} \; 2>/dev/null
  done | sort
}

case "$1" in
  before) snapshot > "$SNAP"; echo "recorded $(wc -l < "$SNAP" | tr -d ' ') entries" ;;
  after)
    snapshot > "$SNAP.after"
    if diff -q "$SNAP" "$SNAP.after" > /dev/null 2>&1; then
      echo "clean — nothing outside GeoCode's own directories changed"
    else
      echo "FOREIGN WRITE DETECTED:"
      diff "$SNAP" "$SNAP.after" | grep '^[<>]' | head -40
      exit 1
    fi ;;
  *) echo "usage: $0 before|after" >&2; exit 2 ;;
esac
