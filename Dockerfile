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
      python3-csdr && \
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

# hackrf_transfer, for raw IQ captures when debugging a decoder outside
# OpenWebRX (stop openwebrx first -- it holds the device).
RUN apt-get update && \
    apt-get install -y --no-install-recommends hackrf && \
    rm -rf /var/lib/apt/lists/*

# Optional Claude Code CLI for debugging inside the container (off by default):
#   docker build --build-arg INSTALL_CLAUDE=true .
# Native binary from npm's per-platform package, pinned by sha256. To bump,
# change the version and both hashes together (sha256sum of each .tgz).
ARG INSTALL_CLAUDE=false
RUN if [ "$INSTALL_CLAUDE" = "true" ]; then \
      version=2.1.287 && \
      case "$(dpkg --print-architecture)" in \
        amd64) platform=linux-x64; sha256=348090e889baacf20e6665fd236e2bc617767eb733407151128efd0281a06111 ;; \
        arm64) platform=linux-arm64; sha256=33ae16d93e1e82b9de10684b540650a9ffbb654eb317e4bfc1ff0f932816f1bc ;; \
        *) echo "INSTALL_CLAUDE: no build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
      esac && \
      curl -fsSL -o /tmp/claude.tgz \
        "https://registry.npmjs.org/@anthropic-ai/claude-code-$platform/-/claude-code-$platform-$version.tgz" && \
      echo "$sha256  /tmp/claude.tgz" | sha256sum -c - && \
      tar -xzf /tmp/claude.tgz -C /usr/local/bin --strip-components=1 package/claude && \
      rm /tmp/claude.tgz; \
    fi

COPY --from=build /build/openwebrx_*.deb /tmp/

# Pin the postinst-created "openwebrx" user to a fixed uid:gid so it's stable
# across rebuilds, for anyone bind-mounting host dirs into the volumes below.
RUN apt-get update && \
    apt-get install -y /tmp/openwebrx_*.deb && \
    rm -rf /tmp/*.deb /var/lib/apt/lists/* && \
    usermod -u 1000 openwebrx && \
    groupmod -g 1000 openwebrx && \
    chown -R openwebrx:openwebrx /var/lib/openwebrx

VOLUME /etc/openwebrx
VOLUME /var/lib/openwebrx

EXPOSE 8073

# Run as non-root so the image works with `docker run --cap-drop=ALL`.
ENV HOME=/tmp
USER openwebrx

CMD ["openwebrx"]
