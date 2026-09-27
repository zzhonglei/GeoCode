#!/bin/sh
# Build the kernel from kernel/ and stage it where the desktop app bundles it from.
# The desktop's prepare:opencode-cli runs this instead of downloading a released CLI.
#
# Usage:  ./scripts/stage-kernel.sh
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLI="$ROOT/kernel/packages/cli"
STAGE="$ROOT/desktop/packages/electron/resources/opencode-cli"
VERSION=$(node -p 'require(process.argv[1]).version' "$ROOT/kernel/package.json")

# Without it the build stamps a 0.0.0-<branch> preview version, which the shell rejects.
(cd "$CLI" && OPENCODE_VERSION="$VERSION" bun run script/build.ts --single --skip-web-ui --skip-install)

set -- "$CLI"/dist/cli-*/bin/opencode
if [ "$#" -ne 1 ] || [ ! -x "$1" ]; then
  echo "expected exactly one built kernel under $CLI/dist, found: $*" >&2
  exit 1
fi

mkdir -p "$STAGE"
cp "$1" "$STAGE/opencode.tmp"
mv "$STAGE/opencode.tmp" "$STAGE/opencode"

# Even --version creates the kernel's data and temp directories and writes its log, so it runs in a throwaway home.
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT
reported=$(unset XDG_DATA_HOME XDG_CONFIG_HOME XDG_STATE_HOME XDG_CACHE_HOME; HOME="$home" TMPDIR="$home" "$STAGE/opencode" --version)
# --version prints "opencode v<version>"
reported=${reported##* }
reported=${reported#v}
if [ "$reported" != "$VERSION" ]; then
  echo "staged kernel reports $reported, expected $VERSION" >&2
  exit 1
fi
echo "staged kernel $VERSION at $STAGE/opencode"
