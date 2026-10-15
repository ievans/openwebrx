#!/bin/sh
# The SDRplay API needs its own daemon next to the SoapySDR module. Keep it
# alive in the background, then become openwebrx so signals and exit codes
# reach the container as before.
if [ -x /opt/sdrplay_api/sdrplay_apiService ]; then
  (
    while :; do
      /opt/sdrplay_api/sdrplay_apiService >/dev/null 2>&1
      sleep 2
    done
  ) &
fi
exec "$@"
