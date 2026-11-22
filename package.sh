#!/bin/bash
#
# package.sh - Create distribution zip files for FoldTube extension
#
# Usage:
#   ./package.sh              # Build both Chrome and Firefox packages
#   ./package.sh chrome       # Build Chrome package only
#   ./package.sh firefox      # Build Firefox package only
#   ./package.sh --output DIR # Specify output directory (default: ./dist)
#
# The source manifest.json uses Chrome's service_worker format.
# For Firefox, the script transforms it to use background.scripts instead,
# and injects data_collection_permissions into gecko settings.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/dist"
VERSION=$(grep -o '"version": *"[^"]*"' "$SCRIPT_DIR/manifest.json" | head -1 | grep -o '[0-9][^"]*')
BUILD_TARGET="all"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    chrome|firefox)
      BUILD_TARGET="$1"
      shift
      ;;
    --output)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [chrome|firefox] [--output DIR]"
      exit 1
      ;;
  esac
done

# Extension files: everything tracked by git, minus repo-only files.
# manifest.json is excluded because it is transformed per browser and added
# separately. Deriving the list from git means a new file can't be silently
# left out of the package (verify_zip below double-checks references).
EXCLUDE_REGEX='^(README\.md|package\.sh|manifest\.json|\..*|\.claude/.*|docs/.*|dist/.*)$'

EXT_FILES=()
while IFS= read -r f; do
  EXT_FILES+=("$f")
done < <(git -C "$SCRIPT_DIR" ls-files | grep -Ev "$EXCLUDE_REGEX")

if [[ ${#EXT_FILES[@]} -eq 0 ]]; then
  echo "Error: no extension files found (is this a git checkout?)" >&2
  exit 1
fi

# Untracked files are not packaged; warn so they aren't forgotten.
UNTRACKED=$(git -C "$SCRIPT_DIR" ls-files --others --exclude-standard | grep -Ev "$EXCLUDE_REGEX" || true)
if [[ -n "$UNTRACKED" ]]; then
  echo "Warning: untracked files will NOT be packaged (git add them to include):" >&2
  echo "$UNTRACKED" | sed 's/^/  /' >&2
fi

# verify_zip ZIP_PATH
# Fails the build if anything the extension references is missing from the
# zip: manifest paths (as transformed for that browser), relative src/href in
# shipped HTML, relative ES module imports, and runtime.getURL("...") paths.
verify_zip() {
  local zip_path="$1"
  local check_dir
  check_dir=$(mktemp -d)
  unzip -q "$zip_path" -d "$check_dir"
  if ! python3 - "$check_dir" "$(basename "$zip_path")" <<'PY'
import json, os, re, sys

root, label = sys.argv[1], sys.argv[2]
missing = []

def need(path, source):
    if not os.path.isfile(os.path.join(root, path)):
        missing.append(f"{path}  (referenced by {source})")

m = json.load(open(os.path.join(root, "manifest.json")))
bg = m.get("background", {})
for p in [bg.get("service_worker")] + bg.get("scripts", []):
    if p: need(p, "manifest background")
for key in ("icons",):
    for p in m.get(key, {}).values(): need(p, f"manifest {key}")
action = m.get("action", {})
icon = action.get("default_icon")
for p in (icon.values() if isinstance(icon, dict) else [icon] if icon else []):
    need(p, "manifest action.default_icon")
for p in [action.get("default_popup"), m.get("options_page"), (m.get("options_ui") or {}).get("page")]:
    if p: need(p, "manifest page")
for cs in m.get("content_scripts", []):
    for p in cs.get("js", []) + cs.get("css", []): need(p, "manifest content_scripts")

def is_relative(u):
    return u and not re.match(r"^([a-z][a-z0-9+.-]*:|//|#)", u, re.I)

for dirpath, _, files in os.walk(root):
    for name in files:
        full = os.path.join(dirpath, name)
        rel = os.path.relpath(full, root)
        base = os.path.dirname(rel)
        if name.endswith(".html"):
            text = open(full, encoding="utf-8").read()
            for u in re.findall(r'\b(?:src|href)\s*=\s*["\']([^"\']+)["\']', text):
                if is_relative(u):
                    need(os.path.normpath(os.path.join(base, u.split("?")[0].split("#")[0])), rel)
        elif name.endswith(".js"):
            text = open(full, encoding="utf-8").read()
            for u in re.findall(r'(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)["\'](\.{1,2}/[^"\']+)["\']', text, re.M):
                need(os.path.normpath(os.path.join(base, u)), rel)
            for u in re.findall(r'getURL\(\s*["\']([^"\']+)["\']', text):
                need(os.path.normpath(u.lstrip("/")), rel)

if missing:
    print(f"  ✗ {label} is missing referenced files:", file=sys.stderr)
    for x in sorted(set(missing)): print(f"      {x}", file=sys.stderr)
    sys.exit(1)
print(f"  ✓ verified: all referenced files present")
PY
  then
    rm -rf "$check_dir"
    rm -f "$zip_path"
    echo "Build failed: $zip_path removed." >&2
    exit 1
  fi
  rm -rf "$check_dir"
}

mkdir -p "$OUTPUT_DIR"

build_chrome() {
  local zip_name="foldtube-v${VERSION}-chrome.zip"
  local zip_path="$OUTPUT_DIR/$zip_name"
  rm -f "$zip_path"

  echo "Building Chrome package..."

  local tmp_dir
  tmp_dir=$(mktemp -d)
  trap "rm -rf '$tmp_dir'" RETURN

  # Copy extension files
  for f in "${EXT_FILES[@]}"; do
    mkdir -p "$tmp_dir/$(dirname "$f")"
    cp "$SCRIPT_DIR/$f" "$tmp_dir/$f"
  done

  # Chrome manifest: strip browser_specific_settings (ignored by Chrome but cleaner)
  python3 -c "
import json, sys
with open('$SCRIPT_DIR/manifest.json') as f:
    m = json.load(f)
m.pop('browser_specific_settings', None)
with open('$tmp_dir/manifest.json', 'w') as f:
    json.dump(m, f, indent=2)
    f.write('\n')
"

  cd "$tmp_dir"
  zip -rq "$zip_path" .
  echo "  -> $zip_path ($(du -h "$zip_path" | cut -f1 | xargs))"
  verify_zip "$zip_path"
}

build_firefox() {
  local zip_name="foldtube-v${VERSION}-firefox.zip"
  local zip_path="$OUTPUT_DIR/$zip_name"
  rm -f "$zip_path"

  echo "Building Firefox package..."

  local tmp_dir
  tmp_dir=$(mktemp -d)
  trap "rm -rf '$tmp_dir'" RETURN

  # Copy extension files
  for f in "${EXT_FILES[@]}"; do
    mkdir -p "$tmp_dir/$(dirname "$f")"
    cp "$SCRIPT_DIR/$f" "$tmp_dir/$f"
  done

  # Firefox manifest: replace service_worker with scripts
  python3 -c "
import json, sys
with open('$SCRIPT_DIR/manifest.json') as f:
    m = json.load(f)

# Swap service_worker -> scripts for Firefox event page
bg = m.get('background', {})
sw = bg.pop('service_worker', None)
if sw:
    bg['scripts'] = [sw]
m['background'] = bg

with open('$tmp_dir/manifest.json', 'w') as f:
    json.dump(m, f, indent=2)
    f.write('\n')
"

  cd "$tmp_dir"
  zip -rq "$zip_path" .
  echo "  -> $zip_path ($(du -h "$zip_path" | cut -f1 | xargs))"
  verify_zip "$zip_path"
}

if [[ "$BUILD_TARGET" == "all" || "$BUILD_TARGET" == "chrome" ]]; then
  build_chrome
fi

if [[ "$BUILD_TARGET" == "all" || "$BUILD_TARGET" == "firefox" ]]; then
  build_firefox
fi

echo ""
echo "Done! Packages are in: $OUTPUT_DIR"
