#!/bin/sh
# The SDRplay API client library talks to sdrplay_apiService, which must run beside it.
# Keep it running for the container's lifetime; it dies with the container when
# openwebrx (PID 1 after the exec) does.
set -eu

(
  while :; do
    sdrplay_apiService || true
    sleep 5
  done
) &

exec "$@"
