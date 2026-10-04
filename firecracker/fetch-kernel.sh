#!/usr/bin/env bash
# Download an uncompressed guest kernel (vmlinux) built by the Firecracker project's CI.
# Any kernel with virtio-mmio, virtio-blk, virtio-net and ext4 built in will do.
set -euo pipefail
cd "$(dirname "$0")"

ARCH=${ARCH:-$(uname -m)}
KERNEL_VERSION=${KERNEL_VERSION:-5.10.225}
CI_VERSION=${CI_VERSION:-v1.11}
OUT=${OUT:-vmlinux}

curl -fSL -o "$OUT" \
  "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/${CI_VERSION}/${ARCH}/vmlinux-${KERNEL_VERSION}"
echo "Wrote $OUT"
