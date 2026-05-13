#!/usr/bin/env bash
# Stop the machtsinn.ai server. Tries PID file first, falls back to port lookup.
# Called from ~/.claude/settings.json SessionEnd hook + manually.

PORT="${MACHTSINN_PORT:-3001}"
PID_FILE="/tmp/machtsinn.pid"

# Try via PID file first
if [[ -f "$PID_FILE" ]]; then
  PID=$(cat "$PID_FILE" 2>/dev/null)
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    # Grace period for SIGTERM, then SIGKILL if still alive
    for i in 1 2 3; do
      sleep 0.3
      kill -0 "$PID" 2>/dev/null || break
    done
    kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

# Catch any orphan listener on the port too
PORT_PIDS=$(lsof -ti:"$PORT" 2>/dev/null)
if [[ -n "$PORT_PIDS" ]]; then
  echo "$PORT_PIDS" | xargs kill -9 2>/dev/null || true
fi

exit 0
