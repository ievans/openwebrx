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

COPY --from=build /build/openwebrx_*.deb /tmp/

RUN apt-get update && \
    apt-get install -y /tmp/openwebrx_*.deb && \
    rm -rf /tmp/*.deb /var/lib/apt/lists/*

VOLUME /etc/openwebrx
VOLUME /var/lib/openwebrx

EXPOSE 8073

CMD ["openwebrx"]
