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
#
# The three that reach it, each verified against the pristine upstream branches:
#   skills/            kernel skill/index.ts CLAUDE_EXTERNAL_DIR, shell skills.js (reads, writes, deletes)
#   CLAUDE.md          kernel session/instruction.ts reads it as agent instructions
#   .credentials.json  shell quota/providers/claude/auth.js reads Claude Code's own OAuth blob
# `ide/`, `agents/` and `commands/` were watched too and nothing upstream names them, so they
# only ever reported Claude Code's own churn.
ROOTS="$HOME/.config/opencode $HOME/.local/share/opencode $HOME/.cache/opencode
       $HOME/.opencode $HOME/.config/openchamber $HOME/.agents
       $HOME/.claude/skills $HOME/.claude/CLAUDE.md $HOME/.claude/.credentials.json
       ${TMPDIR:-/tmp}/opencode"

# Claude Code keeps its synced skills under `skills/synced/<bucket>/` and rewrites their
# manifest on its own schedule. Only those children are skipped; `synced` itself stays in the
# snapshot, so its own entry still moves. Checked against the four shapes that matter: a
# manifest rewrite under a bucket reads clean, while `skills/<name>/SKILL.md`, a write placed
# directly in `synced/` (a skill of that name) and deleting the whole tree (what `deleteSkill`
# would do to it) are each still reported.
PRUNE="*/.claude/skills/synced/*"

# The gate adds GeoCode's own roots through this: a test suite has no business writing into the
# user's data either, and once it does, nothing downstream can tell that write from the app's.
ROOTS="$ROOTS ${FOREIGN_WRITES_EXTRA_ROOTS:-}"
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
    find "$root" -not -path '*/.git/*' -not -path "$PRUNE" -exec stat -f '%N %m %z' {} \; 2>/dev/null
  done | sort
}

case "$1" in
  before)
    snapshot > "$SNAP"
    openchamber_pid > "$SNAP.openchamber"
    echo "recorded $(wc -l < "$SNAP" | tr -d ' ') entries"
    # An `&&` here would make the absence of OpenChamber the branch's exit status, and `before`
    # would report failure on every machine that is not running it. Callers under `set -e` die.
    if [ -s "$SNAP.openchamber" ]; then
      echo "note: OpenChamber.app is running (pid $(cat "$SNAP.openchamber")); its own writes under ~/.config/openchamber are expected"
    fi ;;
  after)
    snapshot > "$SNAP.after"
    if diff -q "$SNAP" "$SNAP.after" > /dev/null 2>&1; then
      echo "clean — nothing under the watched roots changed"
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
