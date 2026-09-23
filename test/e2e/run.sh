#!/bin/bash
#
# Runs the end-to-end browser tests against a real OpenWebRX+ server fed
# by a fake SDR (test/e2e/bin/perseustest). Needs csdr/pycsdr/nmux and
# Playwright with Chromium. Set CHROMIUM_PATH to use a specific browser.
#
set -euo pipefail
cd "$(dirname "$0")/../.."

PORT=${OWRX_TEST_PORT:-18073}
WORK=$(mktemp -d)
mkdir -p "$WORK/data" "$WORK/files"
cp test/e2e/settings.json "$WORK/data/settings.json"
cat > "$WORK/openwebrx.conf" <<CONF
[core]
data_directory = $WORK/data
temporary_directory = $WORK/files
log_level = INFO
[web]
port = $PORT
ipv6 = false
CONF

# Start server in its own process group, so that the SDR processes it
# spawns can be stopped together with it
PATH="$PWD/test/e2e/bin:$PATH" setsid python3 openwebrx.py -c "$WORK/openwebrx.conf" > "$WORK/server.log" 2>&1 < /dev/null &
SERVER=$!

cleanup() {
    status=$?
    kill -- -"$SERVER" 2>/dev/null || true
    if [ $status -ne 0 ]; then
        echo "==== server log ===="
        tail -n 100 "$WORK/server.log"
    fi
    rm -rf "$WORK"
    exit $status
}
trap cleanup EXIT

for i in $(seq 1 60); do
    if curl -sf -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
    if ! kill -0 "$SERVER" 2>/dev/null; then echo "server exited"; exit 1; fi
    sleep 1
done

# Run the given test files, or all of them
if [ $# -gt 0 ]; then TESTS=("$@"); else TESTS=(test/e2e/*.test.js); fi
OWRX_URL="http://127.0.0.1:$PORT" OWRX_FILES="$WORK/files" \
    node --test --test-concurrency=1 "${TESTS[@]}"
