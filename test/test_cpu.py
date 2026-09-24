from unittest import TestCase
from unittest.mock import patch
from owrx.cpu import CpuUsageThread
from contextlib import contextmanager
import io


def fake_files(files):
    """Returns a stand-in for builtins.open() that only knows about `files`,
    a dict of path -> file contents. Any other path raises FileNotFoundError,
    like a real filesystem where the cgroup interface files don't exist."""

    @contextmanager
    def opener(path, mode="r"):
        if path not in files:
            raise FileNotFoundError(path)
        yield io.StringIO(files[path])

    return opener


class MemoryTest(TestCase):
    def setUp(self):
        # bypass __init__(), which touches CoreConfig and probes for
        # temperature sensors; none of that is relevant to memory reporting
        self.thread = CpuUsageThread.__new__(CpuUsageThread)

    def test_cgroup_v2_limit_is_used_when_present(self):
        files = {
            "/proc/meminfo": "MemTotal:       16000000 kB\nMemAvailable:   10000000 kB\n",
            "/sys/fs/cgroup/memory.max": "2000000000\n",
            "/sys/fs/cgroup/memory.current": "1500000000\n",
            "/sys/fs/cgroup/memory.stat": "inactive_file 500000000\nactive_file 100000\n",
        }
        with patch("builtins.open", fake_files(files)):
            memory = self.thread.get_memory()
        self.assertEqual(memory, {"used": 1000000000, "total": 2000000000})

    def test_cgroup_v2_unlimited_falls_back_to_proc_meminfo(self):
        files = {
            "/proc/meminfo": "MemTotal:       16000000 kB\nMemAvailable:   10000000 kB\n",
            "/sys/fs/cgroup/memory.max": "max\n",
        }
        with patch("builtins.open", fake_files(files)):
            memory = self.thread.get_memory()
        self.assertEqual(memory, {"used": 6000000 * 1024, "total": 16000000 * 1024})

    def test_cgroup_v1_limit_is_used_when_present(self):
        files = {
            "/proc/meminfo": "MemTotal:       16000000 kB\nMemAvailable:   10000000 kB\n",
            "/sys/fs/cgroup/memory/memory.limit_in_bytes": "2000000000\n",
            "/sys/fs/cgroup/memory/memory.usage_in_bytes": "1500000000\n",
            "/sys/fs/cgroup/memory/memory.stat": "total_inactive_file 500000000\ntotal_cache 600000000\n",
        }
        with patch("builtins.open", fake_files(files)):
            memory = self.thread.get_memory()
        self.assertEqual(memory, {"used": 1000000000, "total": 2000000000})

    def test_cgroup_v1_unbounded_sentinel_falls_back_to_proc_meminfo(self):
        # docker reports this sentinel when no --memory limit was given
        files = {
            "/proc/meminfo": "MemTotal:       16000000 kB\nMemAvailable:   10000000 kB\n",
            "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
            "/sys/fs/cgroup/memory/memory.usage_in_bytes": "1500000000\n",
        }
        with patch("builtins.open", fake_files(files)):
            memory = self.thread.get_memory()
        self.assertEqual(memory, {"used": 6000000 * 1024, "total": 16000000 * 1024})

    def test_no_cgroup_falls_back_to_proc_meminfo(self):
        files = {
            "/proc/meminfo": "MemTotal:       16000000 kB\nMemAvailable:   10000000 kB\n",
        }
        with patch("builtins.open", fake_files(files)):
            memory = self.thread.get_memory()
        self.assertEqual(memory, {"used": 6000000 * 1024, "total": 16000000 * 1024})

    def test_no_meminfo_and_no_cgroup_returns_none(self):
        with patch("builtins.open", fake_files({})):
            memory = self.thread.get_memory()
        self.assertIsNone(memory)
