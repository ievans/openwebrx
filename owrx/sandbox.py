"""
Optional sandbox for external decoder processes.

Decoders such as rtl_433, multimon-ng or acarsdec parse untrusted RF data, so a
memory-corruption bug in one is a plausible entry point. Most of them only read
samples on stdin and write text on stdout, which means they can be locked down
without capabilities, user namespaces or a privileged helper:

  * Landlock restricts filesystem access to a short allow-list (and nothing
    writable unless a profile asks for it), which keeps config and credentials
    under /etc/openwebrx and /var/lib/openwebrx out of reach.
  * A seccomp filter refuses to create network sockets and to ptrace.

Both are applied by a small launcher (`python3 -m owrx.sandbox ... -- cmd`) that
execs the decoder, so the restrictions are inherited and cannot be lifted by it.

Control with the OPENWEBRX_SANDBOX environment variable:
  off     (default) run decoders unchanged
  auto    sandbox when the kernel supports it, warn and run unchanged otherwise
  strict  refuse to start a decoder if the sandbox cannot be applied
"""

import ctypes
import errno
import logging
import os
import platform
import shutil
import struct
import sys

logger = logging.getLogger(__name__)

ENV_VAR = "OPENWEBRX_SANDBOX"

# profile name -> (allow_network, extra read-write dirs are given per call)
PROFILES = {
    "pipe": False,  # stdin/stdout only
    "net": True,  # keeps sockets, still loses the filesystem
}


def mode() -> str:
    value = os.environ.get(ENV_VAR, "off").strip().lower()
    return value if value in ("off", "auto", "strict") else "off"


def sandboxed(cmd: list, profile: str = "pipe", rw: list = None) -> list:
    """Return the argv to use for `cmd`, prefixed with the sandbox launcher if enabled."""
    if mode() == "off":
        return cmd
    wrapper = [sys.executable, "-m", "owrx.sandbox", "--mode", mode(), "--profile", profile]
    for path in rw or []:
        wrapper += ["--rw", path]
    return wrapper + ["--"] + cmd


# --- Landlock -------------------------------------------------------------

_LANDLOCK_CREATE_RULESET = 444
_LANDLOCK_ADD_RULE = 445
_LANDLOCK_RESTRICT_SELF = 446
_LANDLOCK_CREATE_RULESET_VERSION = 1 << 0
_LANDLOCK_RULE_PATH_BENEATH = 1

_FS_EXECUTE = 1 << 0
_FS_WRITE_FILE = 1 << 1
_FS_READ_FILE = 1 << 2
_FS_READ_DIR = 1 << 3
_FS_WRITE_ACCESS = (1 << 1) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9) | (1 << 10) | (1 << 11) | (1 << 12)

_PR_SET_NO_NEW_PRIVS = 38
_PR_SET_SECCOMP = 22

# Read-only (and executable) system locations. /etc is deliberately not listed as
# a whole, since it holds /etc/openwebrx.
_READ_EXEC_DIRS = ["/usr", "/lib", "/lib32", "/lib64", "/bin", "/sbin", "/opt"]
_READ_DIRS = ["/proc/self"]
_READ_FILES = [
    "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/localtime", "/etc/timezone",
    "/dev/null", "/dev/zero", "/dev/urandom", "/dev/random",
]
_READ_WRITE_FILES = ["/dev/null"]


class SandboxUnavailable(Exception):
    pass


def _libc():
    return ctypes.CDLL(None, use_errno=True)


def _landlock_abi(libc) -> int:
    abi = libc.syscall(_LANDLOCK_CREATE_RULESET, None, 0, _LANDLOCK_CREATE_RULESET_VERSION)
    if abi < 0:
        raise SandboxUnavailable("Landlock not available: " + os.strerror(ctypes.get_errno()))
    return abi


def _apply_landlock(libc, rw_dirs: list) -> None:
    abi = _landlock_abi(libc)
    handled = _FS_EXECUTE | _FS_READ_FILE | _FS_READ_DIR | _FS_WRITE_ACCESS
    if abi >= 2:
        handled |= 1 << 13  # REFER
    if abi >= 3:
        handled |= 1 << 14  # TRUNCATE
    read_only = _FS_EXECUTE | _FS_READ_FILE | _FS_READ_DIR
    # truncate/write on a file only makes sense for files, so only add it there
    write_bits = _FS_WRITE_ACCESS | ((1 << 14) if abi >= 3 else 0)

    attr = struct.pack("Q", handled)
    fd = libc.syscall(_LANDLOCK_CREATE_RULESET, attr, len(attr), 0)
    if fd < 0:
        raise SandboxUnavailable("landlock_create_ruleset: " + os.strerror(ctypes.get_errno()))

    def allow(path, access):
        try:
            pfd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        except OSError:
            return  # optional location that is not present on this system
        try:
            if not os.path.isdir(path):
                # directory-only rights are rejected on non-directories
                access &= ~(_FS_READ_DIR | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9) | (1 << 10) | (1 << 11) | (1 << 12))
            rule = struct.pack("=Qi", access & handled, pfd)
            if libc.syscall(_LANDLOCK_ADD_RULE, fd, _LANDLOCK_RULE_PATH_BENEATH, rule, 0) < 0:
                raise SandboxUnavailable("landlock_add_rule(%s): %s" % (path, os.strerror(ctypes.get_errno())))
        finally:
            os.close(pfd)

    for p in _READ_EXEC_DIRS:
        allow(p, read_only)
    for p in _READ_DIRS:
        allow(p, _FS_READ_FILE | _FS_READ_DIR)
    for p in _READ_FILES:
        allow(p, _FS_READ_FILE)
    for p in _READ_WRITE_FILES:
        allow(p, _FS_READ_FILE | _FS_WRITE_FILE)
    for p in rw_dirs:
        allow(p, read_only | write_bits)

    if libc.syscall(_LANDLOCK_RESTRICT_SELF, fd, 0) < 0:
        raise SandboxUnavailable("landlock_restrict_self: " + os.strerror(ctypes.get_errno()))
    os.close(fd)


# --- seccomp --------------------------------------------------------------

_AUDIT_ARCH = {"x86_64": 0xC000003E, "aarch64": 0xC00000B7}
_SYS = {
    "x86_64": {"socket": 41, "ptrace": 101, "mount": 165, "umount2": 166, "io_uring_setup": 425},
    "aarch64": {"socket": 198, "ptrace": 117, "mount": 40, "umount2": 39, "io_uring_setup": 425},
}

_BPF_LD_W_ABS = 0x20
_BPF_JEQ_K = 0x15
_BPF_JGE_K = 0x35
_BPF_RET_K = 0x06
_SECCOMP_RET_ALLOW = 0x7FFF0000
_SECCOMP_RET_ERRNO = 0x00050000

# socket() families a sandboxed decoder may not create. AF_UNIX stays allowed.
_NET_FAMILIES = [2, 10, 16, 17]  # AF_INET, AF_INET6, AF_NETLINK, AF_PACKET


def _build_filter(allow_network: bool) -> bytes:
    machine = platform.machine()
    if machine not in _AUDIT_ARCH:
        raise SandboxUnavailable("seccomp filter not implemented for " + machine)
    nr = _SYS[machine]
    deny = [nr["ptrace"], nr["mount"], nr["umount2"], nr["io_uring_setup"]]
    deny_ret = _SECCOMP_RET_ERRNO | errno.EPERM
    insns = []

    def stmt(code, k):
        insns.append(struct.pack("=HBBI", code, 0, 0, k))

    def jump(code, k, jt, jf):
        insns.append(struct.pack("=HBBI", code, jt, jf, k))

    # arch check, kill via EPERM on mismatch (e.g. 32-bit compat syscalls)
    stmt(_BPF_LD_W_ABS, 4)
    jump(_BPF_JEQ_K, _AUDIT_ARCH[machine], 1, 0)
    stmt(_BPF_RET_K, deny_ret)
    stmt(_BPF_LD_W_ABS, 0)  # syscall number
    for n in deny:
        jump(_BPF_JEQ_K, n, 0, 1)
        stmt(_BPF_RET_K, deny_ret)
    if not allow_network:
        # not socket(): skip the family checks. Otherwise inspect args[0] (offset 16).
        jump(_BPF_JEQ_K, nr["socket"], 0, 1 + 2 * len(_NET_FAMILIES))
        stmt(_BPF_LD_W_ABS, 16)
        for fam in _NET_FAMILIES:
            jump(_BPF_JEQ_K, fam, 0, 1)
            stmt(_BPF_RET_K, _SECCOMP_RET_ERRNO | errno.EACCES)
    stmt(_BPF_RET_K, _SECCOMP_RET_ALLOW)
    return b"".join(insns)


def _apply_seccomp(libc, allow_network: bool) -> None:
    prog_bytes = _build_filter(allow_network)
    n = len(prog_bytes) // 8
    buf = ctypes.create_string_buffer(prog_bytes, len(prog_bytes))

    class SockFprog(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.c_void_p)]

    prog = SockFprog(n, ctypes.cast(buf, ctypes.c_void_p).value)
    if libc.prctl(_PR_SET_SECCOMP, 2, ctypes.byref(prog), 0, 0) != 0:
        raise SandboxUnavailable("seccomp: " + os.strerror(ctypes.get_errno()))


def apply(profile: str, rw_dirs: list) -> None:
    libc = _libc()
    if libc.prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise SandboxUnavailable("no_new_privs: " + os.strerror(ctypes.get_errno()))
    _apply_landlock(libc, rw_dirs)
    _apply_seccomp(libc, PROFILES[profile])


# --- launcher -------------------------------------------------------------

_KEEP_ENV = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "LD_LIBRARY_PATH")


def main(argv=None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="python3 -m owrx.sandbox")
    parser.add_argument("--mode", choices=["auto", "strict"], default="strict")
    parser.add_argument("--profile", choices=sorted(PROFILES), default="pipe")
    parser.add_argument("--rw", action="append", default=[], help="directory the command may write to")
    parser.add_argument("command", nargs="+")
    args = parser.parse_args(argv)

    exe = shutil.which(args.command[0])
    if exe is None:
        print("sandbox: command not found: " + args.command[0], file=sys.stderr)
        return 127
    try:
        apply(args.profile, args.rw)
    except SandboxUnavailable as e:
        if args.mode == "strict":
            print("sandbox: refusing to run unsandboxed: %s" % e, file=sys.stderr)
            return 126
        print("sandbox: running without sandbox: %s" % e, file=sys.stderr)
    else:
        # drop everything the decoder has no business seeing (tokens, config paths, ...)
        env = {k: v for k, v in os.environ.items() if k in _KEEP_ENV}
        env["HOME"] = "/nonexistent"
        os.environ.clear()
        os.environ.update(env)
    os.execv(exe, [exe] + args.command[1:])


if __name__ == "__main__":
    sys.exit(main())
