#!/bin/sh
# Assemble GeoCode's Python environment (docs/PYTHON.md) from geoengine/environment/ and stage it where the desktop
# app bundles it from. The desktop's prepare:python runs this. With --lock, resolve both platforms' lock files again
# instead, after a change to requirements.in.
#
# Usage:  ./scripts/stage-python.sh [platform]     darwin-arm64 or win32-x64; this computer's by default
#         ./scripts/stage-python.sh --lock
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV="$ROOT/geoengine/environment"
STAGE="$ROOT/desktop/packages/electron/resources/python"
CACHE="$ROOT/.cache/python"
HOST=$(node -p 'process.platform + "-" + process.arch')

# A field of python.json, by its path of keys.
field() {
  node -p 'process.argv.slice(2).reduce((value, key) => value[key], require(process.argv[1]))' "$ENV/python.json" "$@"
}

# Downloads a file once, and stops unless it has the checksum python.json pins.
fetch() {
  url=$1 file=$2 sum=$3
  if [ ! -f "$file" ]; then
    curl -fsSL "$url" -o "$file.tmp"
    mv "$file.tmp" "$file"
  fi
  got=$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$file")
  if [ "$got" != "$sum" ]; then
    rm -f "$file"
    echo "$url has checksum $got, expected $sum" >&2
    exit 1
  fi
}

PYTHON=$(field python)
MINOR=${PYTHON%.*}
mkdir -p "$CACHE"

UV_VERSION=$(field uv version)
UV_ASSET=$(field uv "$HOST" asset)
UV_DIR="$CACHE/uv-$UV_VERSION"
UV="$UV_DIR/uv"
[ "$HOST" = win32-x64 ] && UV="$UV.exe"
if [ ! -x "$UV" ]; then
  fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$UV_ASSET" "$CACHE/$UV_ASSET" "$(field uv "$HOST" sha256)"
  mkdir -p "$UV_DIR"
  case $UV_ASSET in
    *.zip) unzip -qo "$CACHE/$UV_ASSET" -d "$UV_DIR" ;;
    *) tar -xzf "$CACHE/$UV_ASSET" -C "$UV_DIR" --strip-components 1 ;;
  esac
fi
# Nothing from the user's own uv configuration, and no Python of uv's own.
export UV_CACHE_DIR="$CACHE/uv-cache" UV_NO_CONFIG=1 UV_PYTHON_DOWNLOADS=never

if [ "$1" = --lock ]; then
  # macOS first: its wheels need the newer system, so its versions bound Windows's, which then match them.
  MACOSX_DEPLOYMENT_TARGET=14.0 "$UV" pip compile "$ENV/requirements.in" --python-version "$MINOR" \
    --python-platform "$(field platforms darwin-arm64 target)" --only-binary :all: --generate-hashes \
    --custom-compile-command "scripts/stage-python.sh --lock" -o "$ENV/requirements-darwin-arm64.txt"
  sed -n 's/^\([A-Za-z0-9._-]*==[^ ;]*\).*/\1/p' "$ENV/requirements-darwin-arm64.txt" > "$CACHE/constraints.txt"
  "$UV" pip compile "$ENV/requirements.in" --python-version "$MINOR" -c "$CACHE/constraints.txt" \
    --python-platform "$(field platforms win32-x64 target)" --only-binary :all: --generate-hashes \
    --custom-compile-command "scripts/stage-python.sh --lock" -o "$ENV/requirements-win32-x64.txt"
  exit 0
fi

PLATFORM=${1:-$HOST}
TARGET=$(field platforms "$PLATFORM" target)
LOCK="$ENV/requirements-$PLATFORM.txt"
# What the environment is: the Python build, the lock file and this script, which assembles them. Unchanged, it stays
# the same through a rebuild, so an installed copy of it is not unpacked again (docs/PYTHON.md, section 6).
ID=$(node -e '
  const fs = require("fs"), crypto = require("crypto")
  const config = require(process.argv[1])
  const what = JSON.stringify({ python: config.python, release: config.release, build: config.platforms[process.argv[3]] })
  const hash = crypto.createHash("sha256").update(what).update(fs.readFileSync(process.argv[2]))
  process.stdout.write(hash.update(fs.readFileSync(process.argv[4])).digest("hex"))
' "$ENV/python.json" "$LOCK" "$PLATFORM" "$0")

if [ -f "$STAGE/python.tar.gz" ] && [ "$(node -p 'require(process.argv[1]).id' "$STAGE/python.json" 2>/dev/null)" = "$ID" ]; then
  echo "staged Python environment $ID is up to date"
  exit 0
fi

ASSET="cpython-$PYTHON+$(field release)-$TARGET-install_only_stripped.tar.gz"
fetch "https://github.com/astral-sh/python-build-standalone/releases/download/$(field release)/$ASSET" \
  "$CACHE/$ASSET" "$(field platforms "$PLATFORM" sha256)"

BUILD="$CACHE/build-$PLATFORM"
rm -rf "$BUILD"
mkdir -p "$BUILD"
tar -xzf "$CACHE/$ASSET" -C "$BUILD"
if [ "$PLATFORM" = win32-x64 ]; then LIB="$BUILD/python/Lib"; else LIB="$BUILD/python/lib/python$MINOR"; fi

# Installed for the target platform without running its Python, so either platform's environment can be assembled on
# any computer. Only wheels, each matching the lock file's hash.
MACOSX_DEPLOYMENT_TARGET=14.0 "$UV" pip install --target "$LIB/site-packages" --python-platform "$TARGET" \
  --python-version "$MINOR" --only-binary :all: --require-hashes --no-deps -r "$LOCK"
# The packages' command-line scripts, which a --target install writes for some Python of this computer.
rm -rf "$LIB/site-packages/bin"

# pip and uv refuse to install into the base environment (PEP 668).
cat > "$LIB/EXTERNALLY-MANAGED" <<'EOF'
[externally-managed]
Error=No packages can be installed into GeoCode's base Python environment.
EOF

if [ "$PLATFORM" = "$HOST" ]; then
  if [ "$PLATFORM" = win32-x64 ]; then BIN="$BUILD/python/python.exe"; else BIN="$BUILD/python/bin/python3"; fi
  reported=$("$BIN" -I -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')
  if [ "$reported" != "$PYTHON" ]; then
    echo "the assembled Python reports $reported, expected $PYTHON" >&2
    exit 1
  fi
  "$BIN" -I -m pip check
fi

mkdir -p "$STAGE"
rm -f "$STAGE"/*
# Without the AppleDouble files macOS's tar adds for extended attributes.
(cd "$BUILD" && COPYFILE_DISABLE=1 tar -czf "$STAGE/python.tar.gz.tmp" python)
ENTRIES=$(tar -tzf "$STAGE/python.tar.gz.tmp" | wc -l | tr -d ' ')
mv "$STAGE/python.tar.gz.tmp" "$STAGE/python.tar.gz"
printf '{ "id": "%s", "python": "%s", "platform": "%s", "entries": %s }\n' "$ID" "$PYTHON" "$PLATFORM" "$ENTRIES" \
  > "$STAGE/python.json"
rm -rf "$BUILD"
echo "staged Python environment $ID for $PLATFORM at $STAGE"
