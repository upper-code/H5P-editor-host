#!/usr/bin/env bash
#
# Fetch the H5P core and editor runtime assets from the upstream H5P PHP
# libraries at pinned refs, into assets/h5p/{core,editor}, keeping LICENSE
# files. Used for upgrades; the assets are otherwise committed for a hermetic
# deploy.
#
# The core and the editor are versioned separately upstream: the core repo tags
# releases as `1.28.0`, the editor repo has no matching tags. The core ref MUST
# match coreApiVersion / h5pVersion in src/h5p/config.ts.
#
# Local fixes live as patch files in assets/h5p/patches/<core|editor>/ and are
# applied, in file-name order, to the fetched upstream tree before staging, so
# the parity check compares like with like. A patch that no longer applies
# stops the script: rebase it onto the new upstream (or drop it if upstream
# fixed the issue) and run again. --no-patches stages pure upstream instead,
# for inspecting what upstream itself changed.
#
# Usage:
#   bash scripts/fetch-h5p-assets.sh [--core-only] [--no-patches] [core-ref] [editor-ref]
#
# Environment overrides: CORE_REF (default 1.28.0) and EDITOR_REF (no default:
# the editor is fetched only when a ref is given; --core-only skips it).
set -euo pipefail

CORE_ONLY=0
APPLY_PATCHES=1
while [ $# -gt 0 ]; do
  case "$1" in
    --core-only) CORE_ONLY=1 ;;
    --no-patches) APPLY_PATCHES=0 ;;
    --*)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
    *) break ;;
  esac
  shift
done
for arg in "$@"; do
  case "$arg" in
    --*)
      echo "Options must come before the refs: $arg" >&2
      exit 2
      ;;
  esac
done

CORE_REF="${1:-${CORE_REF:-1.28.0}}"
EDITOR_REF="${2:-${EDITOR_REF:-}}"
if [ "$CORE_ONLY" -eq 0 ] && [ -z "$EDITOR_REF" ]; then
  echo "No editor ref given: pass one as the second argument (or EDITOR_REF)," >&2
  echo "or use --core-only. The editor repo has no tags matching the core." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS="$ROOT/assets/h5p"
WORK="$(mktemp -d)"
# Every <name>.new this run creates. On a failed run they are removed, so a
# half-written or orphaned tree is never left under assets/ (where a deploy
# copying assets/ would pick it up). A successful run leaves them for review.
STAGED=()
cleanup() {
  local status=$?
  # Best effort: a failing removal must not skip the rest of the cleanup.
  set +e
  if [ "$status" -ne 0 ]; then
    local dir
    # The +-expansion keeps an empty array safe under `set -u` in bash 3.2.
    for dir in ${STAGED[@]+"${STAGED[@]}"}; do
      rm -rf "$dir"
    done
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

CORE_REPO="https://github.com/h5p/h5p-php-library.git"
EDITOR_REPO="https://github.com/h5p/h5p-editor-php-library.git"

# `git clone --branch` takes tags and branches only; fetching the ref directly
# accepts a commit sha as well.
fetch_ref() {
  local repo="$1" ref="$2" to="$3"
  git init -q "$to"
  git -C "$to" fetch -q --depth 1 "$repo" "$ref"
  git -C "$to" checkout -q FETCH_HEAD
  echo "  at $(git -C "$to" rev-parse HEAD)"
}

# Applies assets/h5p/patches/<name>/*.patch to the fetched checkout. `git apply`
# is all-or-nothing per patch, so a failure leaves no half-applied file.
apply_patches() {
  local name="$1" dir="$2" patch
  [ "$APPLY_PATCHES" -eq 1 ] || return 0
  for patch in "$ASSETS/patches/$name"/*.patch; do
    [ -e "$patch" ] || continue
    if ! git -C "$dir" apply --whitespace=nowarn "$patch"; then
      echo "Local patch no longer applies to upstream $name: $patch" >&2
      echo "Rebase it onto the fetched ref (or delete it if upstream fixed the" >&2
      echo "issue), update assets/h5p/NOTICE, and run this script again." >&2
      exit 1
    fi
    echo "  applied $(basename "$patch")"
  done
}

# Only the runtime trees and the LICENSE are copied. The repo roots also hold
# PHP sources, CI files, composer metadata and docs; the browser needs none of
# them and they would show up as noise in the parity check.
RUNTIME_ENTRIES=(js styles fonts images scripts language libs ckeditor LICENSE.txt)

stage() {
  local from="$1" to="$2"
  STAGED+=("$to.new")
  rm -rf "$to.new"
  mkdir -p "$to.new"
  local entry
  for entry in "${RUNTIME_ENTRIES[@]}"; do
    if [ -e "$from/$entry" ]; then
      cp -R "$from/$entry" "$to.new/"
    fi
  done
  # Safety net: nothing server-side or VCS-related may ship.
  find "$to.new" -name '*.php' -type f -delete
  find "$to.new" -name '.git' -prune -exec rm -rf {} +
  echo "Staged $to.new"
}

# Fetch and patch every requested tree before staging any of them: a failed
# fetch or a patch that no longer applies then stops the run before anything
# is written under assets/.
echo "Fetching H5P core        (${CORE_REPO} @ ${CORE_REF})"
fetch_ref "$CORE_REPO" "$CORE_REF" "$WORK/core"
apply_patches core "$WORK/core"
NAMES=(core)

if [ "$CORE_ONLY" -eq 0 ]; then
  echo "Fetching H5P editor      (${EDITOR_REPO} @ ${EDITOR_REF})"
  fetch_ref "$EDITOR_REPO" "$EDITOR_REF" "$WORK/editor"
  apply_patches editor "$WORK/editor"
  NAMES+=(editor)
fi

for name in "${NAMES[@]}"; do
  stage "$WORK/$name" "$ASSETS/$name"
done

echo
echo "Parity check against the current committed trees:"
for name in "${NAMES[@]}"; do
  if diff -rq "$ASSETS/$name" "$ASSETS/$name.new" >/dev/null 2>&1; then
    echo "  $name: identical — no change"
    rm -rf "$ASSETS/$name.new"
  else
    echo "  $name: DIFFERS — review '$ASSETS/$name.new' and replace '$ASSETS/$name' if intended."
  fi
done

echo
echo "Done. If a tree differs, verify it, then: rm -rf <name> && mv <name>.new <name>"
echo "Never leave <name>.new under assets/. Then update coreApiVersion/h5pVersion"
echo "in src/h5p/config.ts, assets/h5p/NOTICE and THIRD-PARTY-NOTICES.md, and"
echo "bump the package version (it is the ?version= cache-buster)."
echo "Run npm test and npm run test:browser afterwards."
