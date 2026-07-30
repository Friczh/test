#!/bin/sh
set -eu

POT_HOST="${POT_SERVER_HOST:-127.0.0.1}"
POT_PORT="${POT_SERVER_PORT:-4416}"
POT_URL="http://${POT_HOST}:${POT_PORT}"

echo "Starting bgutil-pot server on ${POT_URL} ..."
/usr/local/bin/bgutil-pot server --host "${POT_HOST}" --port "${POT_PORT}" &
POT_PID=$!

cleanup() {
  echo "Shutting down..."
  kill "${POT_PID}" 2>/dev/null || true
  wait "${POT_PID}" 2>/dev/null || true
}
trap cleanup TERM INT

echo "Waiting for bgutil-pot to become healthy..."
attempt=0
max_attempts=30
# Uses Node's built-in fetch instead of curl, so the final image doesn't
# need curl (+ its libcurl transitive deps) installed just for this one
# startup check -- node is already the runtime, no new binary needed.
until node -e "fetch(process.argv[1]).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" "${POT_URL}/ping"; do
  attempt=$((attempt + 1))
  if [ "${attempt}" -ge "${max_attempts}" ]; then
    echo "bgutil-pot did not become healthy after ${max_attempts} attempts; continuing anyway." >&2
    break
  fi
  sleep 1
done
echo "bgutil-pot is ready (or attempts exhausted). Starting MusicButler..."

node src/index.js &
NODE_PID=$!

# Wait on the node process; if it exits, or a TERM/INT arrives, clean up the
# sidecar so the container doesn't hang around after the main process dies.
wait "${NODE_PID}"
EXIT_CODE=$?
cleanup
exit "${EXIT_CODE}"
