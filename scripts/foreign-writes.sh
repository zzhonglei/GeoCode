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

openchamber_pid() {
  pgrep -f 'OpenChamber.app/Contents/MacOS/OpenChamber' 2>/dev/null | head -1
  return 0
}

# The roots OpenChamber and the OpenCode it bundles write for themselves. Derived from ROOTS,
# minus the ones only GeoCode could reach.
THEIRS="$HOME/.config/openchamber $HOME/.config/opencode $HOME/.local/share/opencode
        $HOME/.cache/opencode ${TMPDIR:-/tmp}/opencode"

# Sampling pgrep at `before` and at `after` misses an OpenChamber opened and closed inside the
# window, which is what comparing the two applications side by side looks like. Its own log is
# the evidence that survives the process: newer than the snapshot means it ran during it.
openchamber_ran() {
  [ -s "$SNAP.openchamber" ] && return 0
  [ -n "$(openchamber_pid)" ] && return 0
  log="$HOME/Library/Logs/OpenChamber/main.log"
  [ -f "$log" ] && [ -f "$SNAP" ] && [ "$(stat -f %m "$log")" -gt "$(stat -f %m "$SNAP")" ]
}

# Diff lines naming a path outside THEIRS. One of these is enough to make the whole run ours.
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
    find "$root" -not -path '*/.git/*' -exec stat -f '%N %m %z' {} \; 2>/dev/null
  done | sort
}

case "$1" in
  before)
    snapshot > "$SNAP"
    openchamber_pid > "$SNAP.openchamber"
    echo "recorded $(wc -l < "$SNAP" | tr -d ' ') entries"
    [ -s "$SNAP.openchamber" ] && echo "note: OpenChamber.app is running (pid $(cat "$SNAP.openchamber")); its own writes under ~/.config/openchamber are expected" ;;
  after)
    snapshot > "$SNAP.after"
    if diff -q "$SNAP" "$SNAP.after" > /dev/null 2>&1; then
      echo "clean — nothing outside GeoCode's own directories changed"
    else
      # The verdict reads every changed line; only the report is trimmed, or a foreign write
      # past the fortieth would be judged on lines that were never looked at.
      all_changed="$(diff "$SNAP" "$SNAP.after" | grep '^[<>]')"
      changed="$(printf '%s\n' "$all_changed" | head -40)"
      # A running OpenChamber.app writes its own settings on quit and on every settings
      # change, and the OpenCode it bundles writes the opencode roots. Those are reported
      # apart: the reader confirms them against ~/Library/Logs/OpenChamber/main.log (and the
      # port in its settings.json, which is OpenChamber's), or reruns with it closed.
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
