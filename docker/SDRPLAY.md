# SDRplay (RSP) support in the Docker image

Supported radios are whatever the pinned SDRplay API and SoapySDRPlay3 handle,
including the RSPdx-R2. OpenWebRX+ itself already has an `sdrplay` device type.

## Why it is opt-in

The SDRplay API (`libsdrplay_api` and `sdrplay_apiService`) is proprietary, and its
licence grants no right to redistribute it. So the default image, which the
publish workflow pushes to a public registry, contains none of it. Build the
`sdrplay` target yourself and keep the result private.

## Build

Download `SDRplay_RSP_API-Linux-3.15.2.run` from <https://www.sdrplay.com/api/> into
a directory, read the licence in the package (`sdrplay_license.txt`), then:

```
docker build --target sdrplay \
  --build-context sdrplay-installer=/path/to/dir-with-the-run-file \
  --build-arg SDRPLAY_ACCEPT_LICENSE=yes \
  -t openwebrx:sdrplay .
```

The build checks the installer against `SDRPLAY_API_SHA256` in the Dockerfile and
fails on a mismatch. SDRplay's download URL is unversioned, so keep your own copy
of the pinned file; bump the filename and checksum together to move to a newer API.

## Run

Pass the USB bus through and give the container user access to the radio, as for
the other SDRs. The entrypoint starts `sdrplay_apiService` and restarts it if it
exits.

Only one process can hold the radio at a time. The `docker-sdrplay-test` workflow
checks that the module links against the API and that the service stays up under
the hardened flags, not that a radio opens; that needs hardware.
