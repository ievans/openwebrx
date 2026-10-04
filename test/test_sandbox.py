from unittest import TestCase, skipUnless
from unittest.mock import patch
from owrx import sandbox
import os
import subprocess
import sys


def landlock_available():
    try:
        sandbox._landlock_abi(sandbox._libc())
        return sys.platform == "linux"
    except sandbox.SandboxUnavailable:
        return False


def run_sandboxed(code, profile="pipe", rw=()):
    cmd = sandbox.sandboxed([sys.executable, "-c", code], profile, list(rw))
    return subprocess.run(cmd, capture_output=True, text=True)


class SandboxedCommandTest(TestCase):
    def test_off_by_default(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(sandbox.sandboxed(["rtl_433", "-r", "-"]), ["rtl_433", "-r", "-"])

    def test_unknown_mode_is_off(self):
        with patch.dict(os.environ, {sandbox.ENV_VAR: "bogus"}):
            self.assertEqual(sandbox.sandboxed(["x"]), ["x"])

    def test_wraps_command_when_enabled(self):
        with patch.dict(os.environ, {sandbox.ENV_VAR: "strict"}):
            cmd = sandbox.sandboxed(["rtl_433", "-r", "-"], "pipe", ["/tmp/out"])
        self.assertEqual(cmd[1:3], ["-m", "owrx.sandbox"])
        self.assertIn("--rw", cmd)
        self.assertEqual(cmd[cmd.index("--") + 1:], ["rtl_433", "-r", "-"])


@skipUnless(landlock_available(), "Landlock not supported by this kernel")
class SandboxEnforcementTest(TestCase):
    def setUp(self):
        patcher = patch.dict(os.environ, {sandbox.ENV_VAR: "strict"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_command_still_runs(self):
        self.assertEqual(run_sandboxed("print('ok')").stdout.strip(), "ok")

    def test_inet_socket_denied(self):
        r = run_sandboxed("import socket; socket.socket(socket.AF_INET)")
        self.assertIn("PermissionError", r.stderr)

    def test_unix_socketpair_allowed(self):
        self.assertEqual(run_sandboxed("import socket; socket.socketpair(); print('ok')").stdout.strip(), "ok")

    def test_net_profile_keeps_sockets(self):
        r = run_sandboxed("import socket; socket.socket(socket.AF_INET); print('ok')", "net")
        self.assertEqual(r.stdout.strip(), "ok")

    def test_config_and_tmp_not_accessible(self):
        for path in ("/etc/passwd", "/etc/hostname"):
            r = run_sandboxed("open(%r).read()" % path)
            self.assertIn("PermissionError", r.stderr, path)
        self.assertIn("PermissionError", run_sandboxed("open('/tmp/sandbox-test', 'w')").stderr)

    def test_rw_dir_is_writable(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            r = run_sandboxed("open(%r, 'w').write('x'); print('ok')" % os.path.join(d, "f"), rw=[d])
            self.assertEqual(r.stdout.strip(), "ok")

    def test_environment_is_scrubbed(self):
        with patch.dict(os.environ, {"SECRET_TOKEN": "x"}):
            r = run_sandboxed("import os; print('SECRET_TOKEN' in os.environ)")
        self.assertEqual(r.stdout.strip(), "False")

    def test_strict_refuses_when_unavailable(self):
        with patch.object(sandbox, "_landlock_abi", side_effect=sandbox.SandboxUnavailable("no")):
            self.assertEqual(sandbox.main(["--mode", "strict", "--", "true"]), 126)
