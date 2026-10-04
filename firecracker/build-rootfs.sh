#!/usr/bin/env bash
# Build the Firecracker root filesystem (ext4) from the OpenWebRX+ Docker image.
#
#   ./build-rootfs.sh            # builds ../Dockerfile, then rootfs.ext4 and data.ext4
#   BASE_IMAGE=myimage:tag SKIP_BASE_BUILD=1 ./build-rootfs.sh
#
# Needs docker and mke2fs (e2fsprogs >= 1.43). File ownership from the image has to be
# preserved, so the unpack/mke2fs step runs as root or, failing that, under fakeroot.
set -euo pipefail
cd "$(dirname "$0")"

BASE_IMAGE=${BASE_IMAGE:-openwebrx:latest}
VM_IMAGE=${VM_IMAGE:-openwebrx-fc:latest}
ROOTFS=${ROOTFS:-rootfs.ext4}
DATA=${DATA:-data.ext4}
ROOTFS_SIZE_MB=${ROOTFS_SIZE_MB:-}   # default: exported size + 25%
DATA_SIZE_MB=${DATA_SIZE_MB:-512}

# Stage 2 (unpack the image and create the ext4 files) runs as root or under fakeroot
if [[ ${1:-} != --unpack ]]; then
  if [[ -z ${SKIP_BASE_BUILD:-} ]]; then
    docker build -t "$BASE_IMAGE" ..
  fi
  docker build --build-arg BASE_IMAGE="$BASE_IMAGE" -t "$VM_IMAGE" .

  if [[ $EUID -eq 0 ]]; then wrap=(); elif command -v fakeroot >/dev/null; then wrap=(fakeroot --); else
    echo "run as root or install fakeroot" >&2; exit 1; fi
  export BASE_IMAGE VM_IMAGE ROOTFS DATA ROOTFS_SIZE_MB DATA_SIZE_MB
  exec "${wrap[@]}" "$0" --unpack
fi

work=$(mktemp -d)
cid=
trap 'rm -rf "$work"; [[ -z $cid ]] || docker rm -f "$cid" >/dev/null' EXIT

cid=$(docker create "$VM_IMAGE")
mkdir "$work/root"
# device nodes under dev/ can't be created without root; devtmpfs is mounted at boot anyway
docker export "$cid" | tar -x -C "$work/root" --numeric-owner --exclude='dev/*'

# Things a container runtime normally provides
mkdir -p "$work/root"/{proc,sys,dev,run,tmp,var/tmp,mnt/data}
ln -sf sbin/owrx-init "$work/root/init"
: > "$work/root/etc/resolv.conf"
echo openwebrx > "$work/root/etc/hostname"

if [[ -z $ROOTFS_SIZE_MB ]]; then
  used_kb=$(du -sk "$work/root" | cut -f1)
  ROOTFS_SIZE_MB=$(( used_kb / 1024 * 5 / 4 + 64 ))
fi

rm -f "$ROOTFS"
mke2fs -q -t ext4 -d "$work/root" -L owrx-root "$ROOTFS" "${ROOTFS_SIZE_MB}M"
echo "Wrote $ROOTFS (${ROOTFS_SIZE_MB} MB)"

# Persistent data disk: holds /etc/openwebrx and /var/lib/openwebrx. Never overwritten.
if [[ ! -e $DATA ]]; then
  mke2fs -q -t ext4 -L owrx-data -E root_owner=1000:1000 "$DATA" "${DATA_SIZE_MB}M"
  echo "Wrote $DATA (${DATA_SIZE_MB} MB)"
fi
