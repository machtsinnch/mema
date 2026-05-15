#!/usr/bin/env bash
# Install the mema layer-coloring graph config into the local Obsidian vault.
# Idempotent — won't overwrite an existing config without --force.

set -eu

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${MACHTSINN_VAULT:-$REPO_ROOT/data}/.obsidian"
SRC="$REPO_ROOT/docs/obsidian-graph.example.json"

mkdir -p "$DEST"

if [[ -f "$DEST/graph.json" ]] && [[ "${1:-}" != "--force" ]]; then
  echo "graph.json already exists at $DEST/graph.json"
  echo "Re-run with --force to overwrite, or delete the existing file first."
  exit 1
fi

# Strip the _comment / _palette documentation fields with jq if available;
# fall back to copying the file with the doc fields (Obsidian ignores them).
if command -v jq >/dev/null 2>&1; then
  jq 'del(._comment, ._palette)' "$SRC" > "$DEST/graph.json"
else
  cp "$SRC" "$DEST/graph.json"
fi

echo "Installed mema layer-coloring graph config:"
echo "  $DEST/graph.json"
echo ""
echo "Open the vault in Obsidian; Cmd+G to see the colored layers."
