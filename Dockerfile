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


# Install the proprietary SDRplay API (libsdrplay_api + sdrplay_apiService) if the vendor
# installer is in docker/vendor/ (SDRplay has no stable public download link; see the
# README there). The installer is interactive, so a patch strips its prompts; building
# with it present is what accepts the SDRplay licence. Without it the stage is empty and
# the image builds without the SDRplay API.
FROM debian:bookworm-slim AS sdrplay-build

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      patch sudo file && \
    rm -rf /var/lib/apt/lists/*

ARG SDRPLAY_BINARY=SDRplay_RSP_API-Linux-3.15.2.run
ARG SDRPLAY_MD5=92feae82c39d2e33eec13fc5662a3b9b
# Set to 1 (published image) to fail the build instead of silently omitting SDRplay.
ARG REQUIRE_SDRPLAY=0
WORKDIR /build
COPY docker/patches/SDRplay_RSP_API-Linux-3.15.2.run.patch /build/sdrplay.patch
COPY docker/vendor/ /build/vendor/
RUN mkdir -p /out/opt /out/usr/local/lib && \
    if [ -f "vendor/$SDRPLAY_BINARY" ]; then \
      echo "$SDRPLAY_MD5  vendor/$SDRPLAY_BINARY" | md5sum -c - && \
      sh "vendor/$SDRPLAY_BINARY" --noexec --target sdrplay && \
      patch -Np0 < sdrplay.patch && \
      mkdir -p /etc/udev/rules.d && \
      (cd sdrplay && ./install_lib.sh) && \
      test -x /opt/sdrplay_api/sdrplay_apiService && \
      cp -a /opt/sdrplay_api /out/opt/ && \
      cp -a /usr/local/lib/libsdrplay_api.so* /out/usr/local/lib/; \
    elif [ "$REQUIRE_SDRPLAY" = 1 ]; then \
      echo "REQUIRE_SDRPLAY=1 but vendor/$SDRPLAY_BINARY is missing" >&2; exit 1; \
    else \
      echo "No SDRplay installer in docker/vendor/; building without the SDRplay API"; \
    fi


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
COPY --from=sdrplay-build /out/ /
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --from=csdr-build /build/libcsdr0_*.deb /build/python3-csdr_*.deb /tmp/csdr/

# Pin the postinst-created "openwebrx" user to a fixed uid:gid so it's stable
# across rebuilds, for anyone bind-mounting host dirs into the volumes below.
RUN apt-get update && \
    apt-get install -y /tmp/openwebrx_*.deb && \
    if [ -e /usr/local/lib/libsdrplay_api.so ]; then \
      ldconfig && apt-get install -y soapysdr-module-sdrplay3; \
    fi && \
    dpkg -i /tmp/csdr/*.deb && \
    apt-mark hold libcsdr0 python3-csdr && \
    rm -rf /tmp/*.deb /tmp/csdr /var/lib/apt/lists/* && \
    usermod -u 1000 openwebrx && \
    groupmod -g 1000 openwebrx && \
    chown -R openwebrx:openwebrx /var/lib/openwebrx

VOLUME /etc/openwebrx
VOLUME /var/lib/openwebrx

EXPOSE 8073

# Run as non-root so the image works with `docker run --cap-drop=ALL`.
ENV HOME=/tmp
USER openwebrx

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["openwebrx"]
