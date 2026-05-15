#!/usr/bin/env bash
# Start the machtsinn.ai server if it's not already running. Idempotent.
# Called from ~/.claude/settings.json SessionStart hook + manually.

set -u

PORT="${MACHTSINN_PORT:-3001}"
PID_FILE="/tmp/machtsinn.pid"
LOG_FILE="/tmp/machtsinn.log"

# If port already in use, do nothing — someone else has it.
if lsof -ti:"$PORT" > /dev/null 2>&1; then
  exit 0
fi

# Clean stale PID file
[[ -f "$PID_FILE" ]] && rm -f "$PID_FILE"

# Resolve the repo root from the script's own location — works on any clone path.
# Honors MACHTSINN_ROOT override for non-standard layouts.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${MACHTSINN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

cd "$REPO_ROOT" || exit 0

# Resolve bun from PATH; fall back to ~/.bun/bin/bun for the common install location.
BUN_BIN="$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"

MACHTSINN_RATE_LIMIT_BURST="${MACHTSINN_RATE_LIMIT_BURST:-1000}" \
MACHTSINN_RATE_LIMIT_RPS="${MACHTSINN_RATE_LIMIT_RPS:-10}" \
PORT="$PORT" \
nohup "$BUN_BIN" src/index.ts > "$LOG_FILE" 2>&1 &

echo $! > "$PID_FILE"
disown 2>/dev/null

# Brief wait to confirm it actually came up — don't block the hook for long.
for i in 1 2 3 4 5; do
  if curl -fsS "http://localhost:$PORT/health" > /dev/null 2>&1; then
    exit 0
  fi
  sleep 0.4
done

# Couldn't confirm — leave it running and exit silently so the hook doesn't fail
exit 0
