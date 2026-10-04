#!/bin/sh
# Build GeoEngine from geoengine/ and stage it where the desktop app bundles it from.
# The desktop's prepare:geoengine and its development launcher both run this.
#
# Usage:  ./scripts/stage-geoengine.sh
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENGINE="$ROOT/geoengine"
STAGE="$ROOT/desktop/packages/electron/resources/geoengine"
NAME=geoengine.mjs
if [ ! -d "$ENGINE/node_modules" ]; then
  echo "geoengine/ has no dependencies installed; run: (cd geoengine && bun install)" >&2
  exit 1
fi
(cd "$ENGINE" && bun run build)
mkdir -p "$STAGE"
cp "$ENGINE/dist/$NAME" "$STAGE/$NAME.tmp"
mv "$STAGE/$NAME.tmp" "$STAGE/$NAME"
node --check "$STAGE/$NAME"
echo "staged GeoEngine at $STAGE/$NAME"
