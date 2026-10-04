#!/usr/bin/env bash
# Boot OpenWebRX+ in a Firecracker microVM and publish its web UI on the host.
#
#   sudo ./run.sh            # then browse to http://<host>:8073/
#
# Needs root (tap device + iptables), /dev/kvm, firecracker, iproute2, iptables and curl.
# The serial console is attached to this terminal; Ctrl-C shuts the guest down cleanly.
set -euo pipefail
cd "$(dirname "$0")"

FIRECRACKER=${FIRECRACKER:-firecracker}
KERNEL=${KERNEL:-vmlinux}
ROOTFS=${ROOTFS:-rootfs.ext4}
DATA=${DATA:-data.ext4}
VCPUS=${VCPUS:-2}
MEM_MB=${MEM_MB:-1024}
TAP=${TAP:-owrx-tap0}
HOST_IP=${HOST_IP:-172.16.0.1}
GUEST_IP=${GUEST_IP:-172.16.0.2}
GUEST_MAC=${GUEST_MAC:-06:00:ac:10:00:02}
GUEST_DNS=${GUEST_DNS:-1.1.1.1}
PORT=${PORT:-8073}
# Set NAT=0 to skip the masquerade rule (guest then reaches only the host, e.g. for rtl_tcp)
NAT=${NAT:-1}
API_SOCK=${API_SOCK:-/run/owrx-firecracker.sock}

[[ $EUID -eq 0 ]] || { echo "run.sh must be run as root" >&2; exit 1; }
[[ -c /dev/kvm ]] || { echo "/dev/kvm not available: KVM is required" >&2; exit 1; }
for f in "$KERNEL" "$ROOTFS" "$DATA"; do
  [[ -e $f ]] || { echo "missing $f (see firecracker/README.md)" >&2; exit 1; }
done

uplink=$(ip -4 route show default | awk '{print $5; exit}')
fwd_was=$(cat /proc/sys/net/ipv4/ip_forward)
rules=()

add_rule() {  # add_rule <table> <chain> <args...>; remembered for cleanup
  iptables -t "$1" -A "${@:2}"
  rules+=("$1 ${*:2}")
}

cleanup() {
  set +e
  for r in "${rules[@]}"; do
    # shellcheck disable=SC2086
    iptables -t ${r%% *} -D ${r#* }
  done
  ip link del "$TAP" 2>/dev/null
  echo "$fwd_was" > /proc/sys/net/ipv4/ip_forward
  rm -f "$API_SOCK"
}
trap cleanup EXIT

ip link del "$TAP" 2>/dev/null || true
ip tuntap add dev "$TAP" mode tap
ip addr add "$HOST_IP/30" dev "$TAP"
ip link set "$TAP" up
echo 1 > /proc/sys/net/ipv4/ip_forward
# Reach the guest from other machines and from the host itself via <host>:$PORT
echo 1 > "/proc/sys/net/ipv4/conf/all/route_localnet"
add_rule nat PREROUTING ! -i "$TAP" -p tcp --dport "$PORT" -j DNAT --to-destination "$GUEST_IP:8073"
add_rule nat OUTPUT -o lo -p tcp --dport "$PORT" -j DNAT --to-destination "$GUEST_IP:8073"
add_rule nat POSTROUTING -o "$TAP" -p tcp -d "$GUEST_IP" --dport 8073 -j MASQUERADE
if [[ $NAT == 1 && -n $uplink ]]; then
  add_rule nat POSTROUTING -s "$GUEST_IP/32" -o "$uplink" -j MASQUERADE
fi

boot_args="console=ttyS0 reboot=k panic=1 pci=off ro init=/init random.trust_cpu=on"
boot_args+=" owrx.ip=$GUEST_IP/30 owrx.gw=$HOST_IP owrx.dns=$GUEST_DNS owrx.time=$(date +%s)"

config=$(mktemp)
trap 'rm -f "$config"; cleanup' EXIT
cat > "$config" <<JSON
{
  "boot-source": {
    "kernel_image_path": "$KERNEL",
    "boot_args": "$boot_args"
  },
  "drives": [
    { "drive_id": "rootfs", "path_on_host": "$ROOTFS", "is_root_device": true,  "is_read_only": true },
    { "drive_id": "data",   "path_on_host": "$DATA",   "is_root_device": false, "is_read_only": false }
  ],
  "network-interfaces": [
    { "iface_id": "eth0", "guest_mac": "$GUEST_MAC", "host_dev_name": "$TAP" }
  ],
  "machine-config": { "vcpu_count": $VCPUS, "mem_size_mib": $MEM_MB }
}
JSON

rm -f "$API_SOCK"
"$FIRECRACKER" --api-sock "$API_SOCK" --config-file "$config" &
fc=$!

shutdown_guest() {
  # x86_64: the guest kernel turns Ctrl-Alt-Del into SIGINT for init, which stops openwebrx
  curl -sS --unix-socket "$API_SOCK" -X PUT http://localhost/actions \
    -H 'Content-Type: application/json' -d '{"action_type":"SendCtrlAltDel"}' >/dev/null || true
  for _ in $(seq 1 15); do kill -0 "$fc" 2>/dev/null || return 0; sleep 1; done
  echo "guest did not stop, killing firecracker" >&2
  kill "$fc" 2>/dev/null || true
}
trap shutdown_guest INT TERM

echo "OpenWebRX+ starting in microVM; web UI on http://<host>:$PORT/ (guest $GUEST_IP)"
rc=0
while kill -0 "$fc" 2>/dev/null; do wait "$fc" || rc=$?; done
exit "$rc"
