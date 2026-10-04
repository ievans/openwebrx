# Adds the few tools the microVM's init needs on top of the regular OpenWebRX+ image
# (iproute2 for networking, util-linux's setpriv ships in the base already).
ARG BASE_IMAGE=openwebrx:latest
FROM ${BASE_IMAGE}

USER root
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends iproute2 && \
    rm -rf /var/lib/apt/lists/*
COPY init /sbin/owrx-init
