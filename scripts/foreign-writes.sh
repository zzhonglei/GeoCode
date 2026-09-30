#!/bin/sh
# Snapshot the directories GeoCode must never touch, so a run can be checked
# against them. `before` records; `after` reports any file that appeared or
# changed. It observes writes, not reads.
set -e
# `.claude` is narrowed to the paths the kernel or the shell can reach: Claude
# Code itself writes elsewhere under it continuously. The list is split on
# spaces, so `?` stands for the one in "Application Support"; the loop expands it.
ROOTS="$HOME/.config/opencode $HOME/.local/share/opencode $HOME/.cache/opencode
       $HOME/.local/state/opencode $HOME/Library/Caches/opencode
       $HOME/.opencode $HOME/.config/openchamber $HOME/.agents
       $HOME/Library/Application?Support/OpenChamber $HOME/Library/Logs/OpenChamber
       $HOME/.claude/skills $HOME/.claude/CLAUDE.md $HOME/.claude/.credentials.json
       ${TMPDIR:-/tmp}/opencode"

# Claude Code rewrites the manifests under `skills/synced/<bucket>/` on its own
# schedule. Only those children are skipped; `synced` itself is still watched.
PRUNE="*/.claude/skills/synced/*"

# The gate adds GeoCode's own roots through this.
ROOTS="$ROOTS ${FOREIGN_WRITES_EXTRA_ROOTS:-}"
SNAP="${FOREIGN_WRITES_SNAPSHOT:-/tmp/geocode-foreign-writes}"

openchamber_pid() {
  pgrep -f 'OpenChamber.app/Contents/MacOS/OpenChamber' 2>/dev/null | head -1
  return 0
}

# The roots OpenChamber and the OpenCode it runs write for themselves.
THEIRS="$HOME/.config/openchamber $HOME/.config/opencode $HOME/.local/share/opencode
        $HOME/.cache/opencode $HOME/.local/state/opencode $HOME/Library/Caches/opencode
        $HOME/Library/Application?Support/OpenChamber $HOME/Library/Logs/OpenChamber
        ${TMPDIR:-/tmp}/opencode"

# pgrep at `before` and `after` misses an OpenChamber opened and closed in
# between; its log being newer than the snapshot does not.
openchamber_ran() {
  [ -s "$SNAP.openchamber" ] && return 0
  [ -n "$(openchamber_pid)" ] && return 0
  log="$HOME/Library/Logs/OpenChamber/main.log"
  [ -f "$log" ] && [ -f "$SNAP" ] && [ "$(stat -f %m "$log")" -gt "$(stat -f %m "$SNAP")" ]
}

# Diff lines naming a path outside THEIRS. One is enough to make the run ours.
not_theirs() {
  printf '%s\n' "$1" | while IFS= read -r line; do
    [ -n "$line" ] || continue
    owner=none
    for root in $THEIRS; do
      case "$line" in *"$root"*) owner=theirs ;; esac
    done
    [ "$owner" = theirs ] || printf '%s\n' "$line"
  done
}

snapshot() {
  for root in $ROOTS; do
    [ -e "$root" ] || continue
    # Records the mode too: a chmod leaves mtime and size alone.
    find "$root" -not -path '*/.git/*' -not -path "$PRUNE" -exec stat -f '%N %m %z %p' {} \; 2>/dev/null
  done | sort
}

case "$1" in
  before)
    snapshot > "$SNAP"
    openchamber_pid > "$SNAP.openchamber"
    echo "recorded $(wc -l < "$SNAP" | tr -d ' ') entries"
    # Not `&&`: its status would become the script's, and `before` would fail
    # wherever OpenChamber is not running.
    if [ -s "$SNAP.openchamber" ]; then
      echo "note: OpenChamber.app is running (pid $(cat "$SNAP.openchamber")); its own writes under ~/.config/openchamber are expected"
    fi ;;
  after)
    snapshot > "$SNAP.after"
    if diff -q "$SNAP" "$SNAP.after" > /dev/null 2>&1; then
      echo "clean — nothing under the watched roots changed"
    else
      # The verdict reads every changed line; only the report is trimmed.
      all_changed="$(diff "$SNAP" "$SNAP.after" | grep '^[<>]')"
      changed="$(printf '%s\n' "$all_changed" | head -40)"
      if openchamber_ran && [ -z "$(not_theirs "$all_changed")" ]; then
        echo "writes under OpenChamber's and OpenCode's own roots while OpenChamber.app ran:"
        printf '%s\n' "$changed"
        echo "likely OpenChamber's or its bundled OpenCode's; confirm against ~/Library/Logs/OpenChamber/main.log, or rerun with it closed"
        exit 3
      fi
      echo "FOREIGN WRITE DETECTED:"
      printf '%s\n' "$changed"
      exit 1
    fi ;;
  *) echo "usage: $0 before|after" >&2; exit 2 ;;
esac
