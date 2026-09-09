#!/usr/bin/env bash
#
# Fetch the H5P core and editor runtime assets from the upstream H5P PHP
# libraries at a pinned tag, into assets/h5p/{core,editor}, keeping LICENSE
# files. Used for upgrades; the assets are otherwise committed for a hermetic
# deploy.
#
# The tag MUST match coreApiVersion / h5pVersion in src/h5p/config.ts.
#
# Usage: bash scripts/fetch-h5p-assets.sh [tag]
set -euo pipefail

TAG="${1:-1.27}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS="$ROOT/assets/h5p"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CORE_REPO="https://github.com/h5p/h5p-php-library.git"
EDITOR_REPO="https://github.com/h5p/h5p-editor-php-library.git"

echo "Fetching H5P core        (${CORE_REPO} @ ${TAG})"
git clone --depth 1 --branch "$TAG" "$CORE_REPO" "$WORK/core"

echo "Fetching H5P editor      (${EDITOR_REPO} @ ${TAG})"
git clone --depth 1 --branch "$TAG" "$EDITOR_REPO" "$WORK/editor"

# The runtime assets are the js/styles/fonts/images trees plus the LICENSE.
# The PHP sources are not needed at runtime and are dropped.
stage() {
  local from="$1" to="$2"
  rm -rf "$to.new"
  mkdir -p "$to.new"
  cp -R "$from"/. "$to.new"/
  find "$to.new" -name '*.php' -type f -delete
  rm -rf "$to.new/.git"
  echo "Staged $to.new"
}

stage "$WORK/core"   "$ASSETS/core"
stage "$WORK/editor" "$ASSETS/editor"

echo
echo "Parity check against the current committed trees:"
for name in core editor; do
  if diff -rq "$ASSETS/$name" "$ASSETS/$name.new" >/dev/null 2>&1; then
    echo "  $name: identical — no change"
    rm -rf "$ASSETS/$name.new"
  else
    echo "  $name: DIFFERS — review '$ASSETS/$name.new' and replace '$ASSETS/$name' if intended."
  fi
done

echo
echo "Done. If a tree differs, verify it, then: mv <name>.new <name>"
echo "Remember to update coreApiVersion/h5pVersion in src/h5p/config.ts and assets/h5p/NOTICE."
