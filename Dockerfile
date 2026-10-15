# Build the OpenWebRX+ .deb package from the current sources
FROM debian:bookworm-slim AS build

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential debhelper dh-python python3-all python3-setuptools && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /build/openwebrx
COPY . .
# Skip the unit tests: they import pycsdr, which is only available at runtime
RUN DEB_BUILD_OPTIONS=nocheck dpkg-buildpackage -us -uc -b


# Build libcsdr and pycsdr with a fix for FractionalDecimator, whose float32 read
# position drifts the resampling ratio by tens of ppm (breaks LoRa/Meshtastic at 2.4 Msps).
# The headers change (private members), so pycsdr must be rebuilt along with libcsdr.
FROM debian:bookworm-slim AS csdr-build

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates git build-essential cmake debhelper dh-python \
      python3-all python3-setuptools libpython3-dev libfftw3-dev libsamplerate0-dev && \
    rm -rf /var/lib/apt/lists/*

ARG CSDR_REF=master
ARG PYCSDR_REF=master
WORKDIR /build
COPY docker/patches/libcsdr-fractionaldecimator-double.patch /build/
RUN git clone https://github.com/luarvique/csdr.git csdr && \
    git -C csdr checkout "$CSDR_REF" && \
    git -C csdr apply /build/libcsdr-fractionaldecimator-double.patch && \
    cd csdr && dpkg-buildpackage -us -uc -b && \
    cd .. && dpkg -i libcsdr0_*.deb libcsdr-dev_*.deb && \
    git clone https://github.com/luarvique/pycsdr.git pycsdr && \
    git -C pycsdr checkout "$PYCSDR_REF" && \
    cd pycsdr && dpkg-buildpackage -us -uc -b


# Build our fork of the SoapySDR HackRF module (replaces the distro/PPA one at runtime)
FROM debian:bookworm-slim AS soapyhackrf-build

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates git build-essential cmake pkg-config \
      libsoapysdr-dev libhackrf-dev && \
    rm -rf /var/lib/apt/lists/*

ARG SOAPYHACKRF_REF=763819f4c14c2ef76d00aca002e33fd09a013e30
WORKDIR /build
RUN git clone https://github.com/ievans/SoapyHackRF.git soapyhackrf && \
    git -C soapyhackrf checkout "$SOAPYHACKRF_REF" && \
    cmake -S soapyhackrf -B soapyhackrf/build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr && \
    cmake --build soapyhackrf/build -j"$(nproc)" && \
    DESTDIR=/out cmake --install soapyhackrf/build


# SDRplay API (proprietary; personal-use image, not for redistribution). The download URL
# is unversioned and carries a per-request token, so scrape the link from the vendor page
# and pin the checksum: a new upstream release fails the build rather than changing it.
# Building this image accepts the SDRplay licence (sdrplay_license.txt, copied into it).
FROM debian:bookworm-slim AS sdrplay-api

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

ARG SDRPLAY_API_SHA256=3a97ca764263bbe76fb0f2220e6408942357e8864c19e1408a6d6987af382fe3
RUN set -eu; \
    url=$(curl -fsSL https://sdrplay.com/hardware-api/ \
      | grep -oE 'https://sdrplay.com/download/hardware-api-linux/\?wpdmdl=[0-9]+(&#038;|&amp;|&)refresh=[0-9a-f]+' \
      | head -1 | sed 's/&#038;/\&/; s/&amp;/\&/'); \
    curl -fsSL -o /tmp/sdrplay.run "$url"; \
    echo "$SDRPLAY_API_SHA256  /tmp/sdrplay.run" | sha256sum -c -; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=amd64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "SDRplay API: unsupported architecture" >&2; exit 1 ;; \
    esac; \
    sh /tmp/sdrplay.run --noexec --nox11 --target /tmp/sdrplay; \
    mkdir -p /out/usr/local/bin /out/usr/local/lib /out/usr/local/include /out/usr/share/doc/sdrplay-api; \
    install -m 0755 "/tmp/sdrplay/$arch/sdrplay_apiService" /out/usr/local/bin/; \
    install -m 0644 "/tmp/sdrplay/$arch/libsdrplay_api.so.3.15" /out/usr/local/lib/; \
    install -m 0644 /tmp/sdrplay/inc/*.h /out/usr/local/include/; \
    install -m 0644 /tmp/sdrplay/sdrplay_license.txt /out/usr/share/doc/sdrplay-api/


# The OpenWebRX+ maintainer's SoapySDRPlay3 fork (tag 0.8.11; RSPdx-R2 support, API 3.15.2).
FROM debian:bookworm-slim AS soapysdrplay-build

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates git build-essential cmake pkg-config libsoapysdr-dev && \
    rm -rf /var/lib/apt/lists/*

# Its CMake finder looks for sdrplay_api.h and libsdrplay_api under /usr/local.
COPY --from=sdrplay-api /out/usr/local/ /usr/local/
RUN ln -s libsdrplay_api.so.3.15 /usr/local/lib/libsdrplay_api.so && ldconfig

ARG SOAPYSDRPLAY3_REF=146ce1c2f6ecfe913cb37a7431f80713e43a5339
WORKDIR /build
RUN git clone https://github.com/luarvique/SoapySDRPlay3.git soapysdrplay3 && \
    git -C soapysdrplay3 checkout "$SOAPYSDRPLAY3_REF" && \
    cmake -S soapysdrplay3 -B soapysdrplay3/build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr && \
    cmake --build soapysdrplay3/build -j"$(nproc)" && \
    DESTDIR=/out cmake --install soapysdrplay3/build


# Runtime image: install the freshly built package, pulling its
# dependencies (csdr, owrx-connector, digiham, ...) from the OpenWebRX+ repo
FROM debian:bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg && \
    curl -fsSL https://luarvique.github.io/ppa/openwebrx-plus.gpg | \
      gpg --dearmor -o /etc/apt/trusted.gpg.d/openwebrx-plus.gpg && \
    echo "deb [signed-by=/etc/apt/trusted.gpg.d/openwebrx-plus.gpg] https://luarvique.github.io/ppa/bookworm ./" \
      > /etc/apt/sources.list.d/openwebrx-plus.list && \
    rm -rf /var/lib/apt/lists/*

# Pre-install openwebrx's dependencies (debian/control's Depends + Recommends) before
# copying in the freshly built .deb below. That COPY's content changes on every commit
# and busts the cache for everything after it, so without this the ~450 packages here
# would reinstall from scratch on every build. This layer only reruns when the list
# itself changes; if debian/control adds a package we haven't added here, apt still
# pulls it in via the final install below, just without the cache benefit.
#
# Depends are hard requirements: fail the build if one is missing. Recommends are
# best-effort, same as apt's own handling of a package's Recommends field -- some
# (e.g. dream-headless, perseus-tools) aren't actually installable on this
# architecture, so we probe each with `apt-get install --dry-run` and skip the ones
# that fail instead of letting the real install hard-fail on them. Neither `apt-cache
# show` (matches a package's metadata regardless of whether it's installable) nor
# `apt-cache policy` (reports a "Candidate" version without checking whether that
# version's own dependencies resolve) catch a package whose Depends can't be
# satisfied on this architecture; only actually asking the resolver does.
RUN apt-get update && \
    apt-get install -y \
      adduser \
      python3 \
      python3-pkg-resources \
      python3-distutils-extra \
      owrx-connector \
      python3-csdr \
      libusb-1.0-0 \
      soapysdr-tools \
      libudev1 && \
    AVAILABLE_RECOMMENDS="" && \
    for pkg in \
      python3-digiham \
      direwolf \
      wsjtx \
      js8call \
      runds-connector \
      hpsdrconnector \
      aprs-symbols \
      m17-demod \
      python3-js8py \
      nmux \
      codecserver \
      msk144decoder \
      dump1090-fa-minimal \
      dump978-fa-minimal \
      dumphfdl \
      dumpvdl2 \
      acarsdec \
      rtl-433 \
      extra-sdr-drivers \
      perseus-tools \
      dream-headless \
      codec2 \
      redsea \
      python3-csdr-eti \
      python3-paho-mqtt \
      python3-meshtastic \
      python3-pycryptodome \
      dablin \
      multimon-ng \
      imagemagick \
      nrsc5 \
      libhamlib-utils \
      csdr-skimmer \
      sonde-decoders \
      dxlaprs-lora \
      lame \
      dream; \
    do \
      apt-get install --dry-run -y "$pkg" >/dev/null 2>&1 && \
        AVAILABLE_RECOMMENDS="$AVAILABLE_RECOMMENDS $pkg" || true; \
    done && \
    apt-get install -y $AVAILABLE_RECOMMENDS && \
    rm -rf /var/lib/apt/lists/*

COPY --from=build /build/openwebrx_*.deb /tmp/
COPY --from=soapyhackrf-build /out/ /
COPY --from=sdrplay-api /out/usr/local/bin/ /usr/local/bin/
COPY --from=sdrplay-api /out/usr/local/lib/ /usr/local/lib/
COPY --from=sdrplay-api /out/usr/share/doc/sdrplay-api/ /usr/share/doc/sdrplay-api/
COPY --from=soapysdrplay-build /out/ /
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --from=csdr-build /build/libcsdr0_*.deb /build/python3-csdr_*.deb /tmp/csdr/

# Pin the postinst-created "openwebrx" user to a fixed uid:gid so it's stable
# across rebuilds, for anyone bind-mounting host dirs into the volumes below.
RUN apt-get update && \
    apt-get install -y /tmp/openwebrx_*.deb && \
    dpkg -i /tmp/csdr/*.deb && \
    apt-mark hold libcsdr0 python3-csdr && \
    rm -rf /tmp/*.deb /tmp/csdr /var/lib/apt/lists/* && \
    usermod -u 1000 openwebrx && \
    groupmod -g 1000 openwebrx && \
    chown -R openwebrx:openwebrx /var/lib/openwebrx && \
    ldconfig

VOLUME /etc/openwebrx
VOLUME /var/lib/openwebrx

EXPOSE 8073

# Run as non-root so the image works with `docker run --cap-drop=ALL`.
ENV HOME=/tmp
USER openwebrx

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["openwebrx"]
