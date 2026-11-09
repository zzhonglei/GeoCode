#!/bin/sh
# Prepare GeoCode's Python environment from geoengine/environment/ and stage it where the
# desktop app bundles it from: one platform's conda packages packed by pixi-pack, and pixi-unpack, which installs them
# on the user's computer. The desktop's prepare:python runs this. With --lock, resolve pixi.lock for both platforms
# again instead, after a change to pixi.toml.
#
# Usage:  ./scripts/stage-python.sh [platform]     darwin-arm64 or win32-x64; this computer's by default
#         ./scripts/stage-python.sh --lock
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV="$ROOT/geoengine/environment"
STAGE="$ROOT/desktop/packages/electron/resources/python"
CACHE="$ROOT/.cache/python"
HOST=$(node -p 'process.platform + "-" + process.arch')

# A field of tools.json, by its path of keys.
field() {
  node -p 'process.argv.slice(2).reduce((value, key) => value[key], require(process.argv[1]))' "$ENV/tools.json" "$@"
}

# Downloads a file once, and stops unless it has the checksum tools.json pins.
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

# Prints the path of a tool of tools.json built for a platform, downloading it the first time.
tool() {
  asset=$(field "$1" "$2" asset)
  folder="$CACHE/$1-$(field "$1" version)-$2"
  case $asset in
    *.exe | *.zip) binary="$folder/$1.exe" ;;
    *) binary="$folder/$1" ;;
  esac
  if [ ! -f "$binary" ]; then
    fetch "https://github.com/$(field "$1" repository)/releases/download/$(field "$1" version)/$asset" \
      "$CACHE/$asset" "$(field "$1" "$2" sha256)"
    mkdir -p "$folder"
    case $asset in
      *.zip) unzip -qo "$CACHE/$asset" -d "$folder" ;;
      *.tar.gz) tar -xzf "$CACHE/$asset" -C "$folder" ;;
      *) cp "$CACHE/$asset" "$binary" ;;
    esac
    chmod +x "$binary"
  fi
  echo "$binary"
}

mkdir -p "$CACHE"
# The packages are downloaded into the cache here.
export PIXI_HOME="$CACHE/pixi" PIXI_CACHE_DIR="$CACHE/packages" RATTLER_CACHE_DIR="$CACHE/packages"

if [ "$1" = --lock ]; then
  # Without the user's own pixi configuration, which could add channels or mirrors.
  "$(tool pixi "$HOST")" lock --no-config --manifest-path "$ENV/pixi.toml"
  exit 0
fi

PLATFORM=${1:-$HOST}
case $PLATFORM in
  darwin-arm64) CONDA=osx-arm64 ;;
  win32-x64) CONDA=win-64 ;;
  *) echo "no Python environment for $PLATFORM" >&2 && exit 1 ;;
esac

# How the packages are installed on the user's computer, beyond pixi-unpack's version, here and by GeoEngine (install
# and prune in geoengine/src/python/index.ts): raise it with a change that installs them otherwise, and only then, as a
# new id reinstalls every user's environment.
INSTALL=1

# What the environment is: the addresses of the platform's packages in pixi.lock, which name each build, the version of
# pixi-unpack, which installs them, and INSTALL.
# Unchanged, it stays the same through a rebuild, so an installed copy of it is not installed again. Printed with the
# Python version its packages hold and how many they are, which the loading screen counts up to as they install.
DEFINED=$(node -e '
  const fs = require("fs"), crypto = require("crypto")
  const [lock, platform, unpack, install] = process.argv.slice(1)
  // Without carriage returns, which a Windows checkout may add, so the id is the same there.
  const read = (file) => fs.readFileSync(file, "utf-8").replace(/\r/g, "")
  const section = read(lock).match(new RegExp(`^      ${platform}:\\n((?:      - .*\\n)+)`, "m"))
  if (!section) throw new Error(`pixi.lock has no packages for ${platform}`)
  const packages = section[1].split("\n").filter(Boolean).map((line) => line.trim()).sort()
  const python = packages.map((line) => line.match(/\/python-(\d+\.\d+\.\d+)-[^/]*\.conda$/)).find(Boolean)
  if (!python) throw new Error(`pixi.lock has no Python for ${platform}`)
  const hash = crypto.createHash("sha256").update(platform + "\n" + packages.join("\n"))
  hash.update("\npixi-unpack " + unpack + "\ninstall " + install)
  // Counted as pixi-unpack unpacks them into its cache and conda-meta, which a package from PyPI is not.
  const conda = packages.filter((line) => line.startsWith("- conda:")).length
  process.stdout.write(hash.digest("hex") + " " + python[1] + " " + conda)
' "$ENV/pixi.lock" "$CONDA" "$(field pixi-unpack version)" "$INSTALL")
ID=${DEFINED%% *}
PACKAGES=${DEFINED##* }
PYTHON=${DEFINED#* }
PYTHON=${PYTHON% *}
JSON=$(printf '{ "id": "%s", "python": "%s", "platform": "%s", "packages": %s }' "$ID" "$PYTHON" "$PLATFORM" "$PACKAGES")

# pixi-pack packs pixi.lock as it is, without checking it against pixi.toml, and the id above leaves pixi.toml out: a
# change to pixi.toml not locked again would ship the old environment. A lock that matches is checked without network.
PIXI=$(tool pixi "$HOST")
if ! "$PIXI" lock --check --no-config --manifest-path "$ENV/pixi.toml" >/dev/null; then
  echo "pixi.lock does not match pixi.toml: run $0 --lock, and commit pixi.lock with it" >&2
  exit 1
fi

# All of python.json, so a stage from before it held a field GeoEngine reads is written again.
if [ -f "$STAGE/python.tar" ] && [ "$(cat "$STAGE/python.json" 2>/dev/null)" = "$JSON" ]; then
  echo "staged Python environment $ID is up to date"
  exit 0
fi

PACK=$(tool pixi-pack "$HOST")
UNPACK=$(tool pixi-unpack "$PLATFORM")
# The packages as they are, each matching pixi.lock's checksum. Nothing of them runs, so either platform's can be
# packed on any computer.
"$PACK" "$ENV/pixi.toml" --platform "$CONDA" --use-cache "$CACHE/packages" -o "$CACHE/python-$PLATFORM.tar"

if [ "$PLATFORM" = "$HOST" ]; then
  # Installed once here as on a user's computer, to check what it holds.
  CHECK="$CACHE/check"
  rm -rf "$CHECK"
  mkdir -p "$CHECK/temporary"
  TMPDIR="$CHECK/temporary" TMP="$CHECK/temporary" TEMP="$CHECK/temporary" \
    "$UNPACK" "$CACHE/python-$PLATFORM.tar" --output-directory "$CHECK" --env-name base
  if [ "$PLATFORM" = win32-x64 ]; then BIN="$CHECK/base/python.exe"; else BIN="$CHECK/base/bin/python3"; fi
  # Without a line end: Windows's Python ends one with a carriage return, which the substitution keeps.
  reported=$("$BIN" -I -c 'import sys; sys.stdout.write("%d.%d.%d" % sys.version_info[:3])')
  if [ "$reported" != "$PYTHON" ]; then
    echo "the installed Python reports $reported, expected $PYTHON" >&2
    exit 1
  fi
  "$BIN" -I -m pip check
  rm -rf "$CHECK"
fi

mkdir -p "$STAGE"
rm -f "$STAGE"/*
mv "$CACHE/python-$PLATFORM.tar" "$STAGE/python.tar"
cp "$UNPACK" "$STAGE/"
printf '%s\n' "$JSON" > "$STAGE/python.json"
echo "staged Python environment $ID for $PLATFORM at $STAGE"
