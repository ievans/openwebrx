# OpenWebRX+ in a Firecracker microVM

This directory runs the regular OpenWebRX+ Docker image (the top-level `Dockerfile`) as a
[Firecracker](https://firecracker-microvm.github.io/) microVM instead of a container. The image
is built exactly as before; `build-rootfs.sh` then flattens it into an ext4 root filesystem, and
a small `init` script takes over the container runtime's job.

| Docker                                   | Firecracker                                                    |
|------------------------------------------|----------------------------------------------------------------|
| image layers                             | `rootfs.ext4` (read-only drive)                                |
| `VOLUME /etc/openwebrx`, `/var/lib/openwebrx` | `data.ext4` (second drive, bind-mounted over both paths)  |
| `USER openwebrx`, `CMD openwebrx`        | `init` drops to uid/gid 1000 via `setpriv` and runs `openwebrx` |
| `-p 8073:8073`                           | tap device + iptables DNAT (`run.sh`)                          |
| `--read-only --tmpfs /tmp`               | root mounted `ro`, tmpfs on `/tmp`, `/run`, `/var/tmp`         |
| `-e OPENWEBRX_*`                         | `vm.env` file on the data disk                                 |

## Usage

Requires a Linux host with KVM (`/dev/kvm`), the `firecracker` binary, docker, e2fsprogs,
iproute2, iptables and curl.

```
./fetch-kernel.sh          # guest kernel (vmlinux) from the Firecracker CI bucket, or bring your own
./build-rootfs.sh          # docker build, then rootfs.ext4 + data.ext4 (root or fakeroot)
sudo ./run.sh              # boots the VM, web UI on http://<host>:8073/
```

Ctrl-C shuts the guest down cleanly (x86_64; on aarch64 Firecracker has no Ctrl-Alt-Del action,
so `run.sh` falls back to killing the VM after 15 s).

Tunables are environment variables, see the top of each script (`VCPUS`, `MEM_MB`, `PORT`,
`GUEST_IP`, `NAT`, `FIRECRACKER`, ...).

### Configuration and admin account

Settings, users and bookmarks persist on `data.ext4` (`etc/` and `lib/` inside it). To create an
admin account on first boot, put the variables from the main README in a `vm.env` on that disk:

```
sudo mount -o loop data.ext4 /mnt
printf 'OPENWEBRX_ADMIN_USER=admin\nOPENWEBRX_ADMIN_PASSWORD=changeme\n' | sudo tee /mnt/lib/vm.env
sudo umount /mnt
```

(The password is deliberately not passed on the kernel command line, which any process in the
guest can read from `/proc/cmdline`.)

## Hardware SDRs: the main difference from Docker

**Firecracker cannot pass USB (or PCI) devices through to a guest.** `docker run --device
/dev/bus/usb` has no equivalent, so a dongle plugged into the host is not visible inside the VM.
Keep the SDR driver on the host and reach it over the network, using sources OpenWebRX+ already
supports:

- RTL-SDR: run `rtl_tcp -a 172.16.0.1` on the host and add an `rtl_tcp` source pointing at
  `172.16.0.1:1234`.
- Anything with a SoapySDR driver (HackRF, Airspy, ...): run `SoapySDRServer --bind` on the host and
  use a `soapy_remote` source.
- Sources that are already network-based (SDRplay API server, `connector` sources, rtl_tcp on another
  machine) work unchanged; set `NAT=1` (default) so the guest can reach them.

If you need the USB device inside the guest itself, use a hypervisor with device passthrough
(Cloud Hypervisor, QEMU) or keep using the container.

## Status

Written and reviewed but **not booted**: the environment this was authored in has no `/dev/kvm`
and no running Docker daemon. Expect to fix small things on first boot, most likely kernel config
(needs virtio-mmio, virtio-blk, virtio-net, ext4, devtmpfs and sysrq built in) and the size of the
rootfs/data disks.
