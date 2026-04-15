#!/bin/sh
set -e
PORT="${PORT:-10031}"
export PORT

SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
}
trap cleanup INT TERM

echo "[docker-entrypoint] starting Express on port ${PORT}"
node /app/server.js &
SERVER_PID=$!

echo "[docker-entrypoint] waiting for http://127.0.0.1:${PORT}/"
i=0
while ! curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 90 ]; then
    echo "[docker-entrypoint] timeout waiting for Express"
    cleanup
    exit 1
  fi
  sleep 1
done

echo "[docker-entrypoint] Express ready; POST /command {\"command\":\"start\",\"sip\":\"…\",\"user\":\"…\"}"

wait "$SERVER_PID"
STATUS=$?
cleanup
exit "$STATUS"
