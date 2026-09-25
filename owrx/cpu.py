from owrx.config.core import CoreConfig

import threading
import os.path
import os
import re

import logging

logger = logging.getLogger(__name__)


class CpuUsageThread(threading.Thread):
    sharedInstance = None
    creationLock = threading.Lock()

    @staticmethod
    def getSharedInstance():
        with CpuUsageThread.creationLock:
            if CpuUsageThread.sharedInstance is None:
                CpuUsageThread.sharedInstance = CpuUsageThread()
        return CpuUsageThread.sharedInstance

    def __init__(self):
        self.clients = []
        self.doRun = True
        self.last_worktime = 0
        self.last_idletime = 0

        # Determine where to read CPU temperature from
        tempFile = CoreConfig().get_temperature_sensor()
        if tempFile is not None and os.path.isfile(tempFile):
            self.tempFile = tempFile
        else:
            self.tempFile = None

        # Check sensors in /sys/class/thermal
        if self.tempFile is None:
            tempRoot = "/sys/class/thermal"
            try:
                for file in os.listdir(tempRoot):
                    if re.match(r"thermal_zone\d+", file):
                        tempFile = tempRoot + "/" + file + "/temp"
                        if os.path.isfile(tempFile):
                            self.tempFile = tempFile
                            break
            except Exception:
                pass

        # Check monitors in /sys/class/hwmon
        if self.tempFile is None:
            tempRoot = "/sys/class/hwmon"
            try:
                for file in os.listdir(tempRoot):
                    if re.match(r"hwmon\d+", file):
                        tempFile = tempRoot + "/" + file + "/device/temp"
                        if os.path.isfile(tempFile):
                            self.tempFile = tempFile
                            break
            except Exception:
                pass

        self.endEvent = threading.Event()
        self.startLock = threading.Lock()
        super().__init__()

    def run(self):
        logger.debug("cpu usage thread starting up")
        while self.doRun:
            memory = self.get_memory()
            try:
                cpu_usage = self.get_cpu_usage()
                temperature = self.get_temperature()
                (voltage, current, charge, charger) = self.get_battery()
            except:
                cpu_usage = 0
                temperature = 0
                voltage = 0.0
                current = 0.0
                charger = False
                charge = 0
            for c in self.clients:
                c.write_temperature(temperature)
                c.write_cpu_usage(cpu_usage)
                if memory is not None:
                    c.write_memory(memory)
                if voltage > 0.0:
                    c.write_battery({
                        "voltage": voltage,
                        "current": current,
                        "charger": charger,
                        "charge":  charge
                    })
            self.endEvent.wait(timeout=3)
        logger.debug("cpu usage thread shut down")

    # Memory in use and total, in bytes, or None if unknown. Prefers the
    # cgroup memory limit (i.e. what a container is actually confined to)
    # and falls back to whole-system memory when there is no such limit,
    # e.g. on bare metal or in an unrestricted container. Static, so that
    # others (e.g. the IQ buffer's memory limit) can use it too.
    @staticmethod
    def get_memory():
        return CpuUsageThread._get_memory_cgroup() or CpuUsageThread._get_memory_proc()

    # System memory in use and total, in bytes, or None if unknown
    @staticmethod
    def _get_memory_proc():
        try:
            info = {}
            with open("/proc/meminfo", "r") as f:
                for line in f:
                    key, value = line.split(":", 1)
                    info[key] = int(value.split()[0]) * 1024
            total = info["MemTotal"]
            available = info.get("MemAvailable", info.get("MemFree", 0))
            return {"used": total - available, "total": total}
        except Exception:
            return None

    # Total system memory in bytes, or None if unknown. Only used to tell an
    # actual cgroup memory limit apart from the "no limit" case, which is
    # reported as a sentinel far larger than any real amount of memory.
    @staticmethod
    def _get_host_memory_total():
        try:
            with open("/proc/meminfo", "r") as f:
                for line in f:
                    key, value = line.split(":", 1)
                    if key == "MemTotal":
                        return int(value.split()[0]) * 1024
        except Exception:
            pass
        return None

    # Memory in use and the cgroup memory limit, in bytes, for the cgroup
    # this process is confined to. Returns None if there is no memory
    # controller, or it reports no limit (not actually memory-constrained).
    #
    # The limit need not be set on the cgroup mount's root: a systemd
    # service (MemoryMax=), a container sharing the host's cgroup namespace
    # or a nested cgroup has it further down, and any ancestor's limit
    # applies too. So check this process' own cgroup, as listed in
    # /proc/self/cgroup, and all its ancestors, and take the tightest one.
    @staticmethod
    def _get_memory_cgroup():
        host_total = CpuUsageThread._get_host_memory_total()
        v2Path, v1Path = CpuUsageThread._get_cgroup_paths()

        # cgroup v2 (unified hierarchy)
        memory = CpuUsageThread._get_cgroup_limit(
            CpuUsageThread._get_cgroup_dirs("/sys/fs/cgroup", v2Path),
            "memory.max", "memory.current", "inactive_file", host_total
        )
        if memory is not None:
            return memory

        # cgroup v1
        return CpuUsageThread._get_cgroup_limit(
            CpuUsageThread._get_cgroup_dirs("/sys/fs/cgroup/memory", v1Path),
            "memory.limit_in_bytes", "memory.usage_in_bytes", "total_inactive_file", host_total
        )

    # This process' cgroup v2 path and cgroup v1 memory controller path,
    # from /proc/self/cgroup. "/" (i.e. just the mount's root) if unknown.
    @staticmethod
    def _get_cgroup_paths():
        v2Path = v1Path = "/"
        try:
            with open("/proc/self/cgroup", "r") as f:
                for line in f:
                    parts = line.strip().split(":", 2)
                    if len(parts) != 3:
                        continue
                    if parts[0] == "0" and parts[1] == "":
                        v2Path = parts[2]
                    elif "memory" in parts[1].split(","):
                        v1Path = parts[2]
        except Exception:
            pass
        return v2Path, v1Path

    # Directory of the cgroup PATH below MOUNT and of all its ancestors up
    # to MOUNT, innermost first. Inside a container with its own cgroup
    # namespace, the path is "/" and just MOUNT is left. If the path is
    # not visible below the mount, its directories simply do not exist.
    @staticmethod
    def _get_cgroup_dirs(mount, path):
        parts = [p for p in path.strip().split("/") if p]
        dirs = []
        while True:
            dirs.append("/".join([mount] + parts))
            if not parts:
                return dirs
            parts.pop()

    # Tightest memory limit set in any of DIRS, with the memory in use in
    # that same cgroup, since that is what counts against the limit. A
    # limit of "max" or beyond host memory means no limit.
    @staticmethod
    def _get_cgroup_limit(dirs, limitFile, usageFile, inactiveKey, host_total):
        best = None
        for d in dirs:
            try:
                with open(d + "/" + limitFile, "r") as f:
                    limit = f.read().strip()
                if limit == "max":
                    continue
                total = int(limit)
            except Exception:
                continue
            if host_total is not None and total >= host_total:
                continue
            if best is None or total < best[0]:
                best = (total, d)
        if best is None:
            return None
        total, d = best
        try:
            with open(d + "/" + usageFile, "r") as f:
                usage = int(f.read().strip())
        except Exception:
            return None
        inactive = CpuUsageThread._read_cgroup_stat(d + "/memory.stat", inactiveKey)
        return {"used": max(usage - inactive, 0), "total": total}

    # Reads a single "key value" stat out of a cgroup memory.stat file
    @staticmethod
    def _read_cgroup_stat(path, key):
        try:
            with open(path, "r") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) == 2 and parts[0] == key:
                        return int(parts[1])
        except Exception:
            pass
        return 0

    def get_temperature(self):
        # Must have temperature file
        if self.tempFile is None:
            return 0
        # Try opening and reading file
        try:
            f = open(self.tempFile, "r")
        except:
            return 0
        line = f.readline()
        f.close()
        # Try parsing read temperature
        try:
            return int(line) // 1000
        except:
            return 0

    def get_cpu_usage(self):
        try:
            f = open("/proc/stat", "r")
        except:
            return 0  # Workaround, possibly we're on a Mac
        line = ""
        while not "cpu " in line:
            line = f.readline()
        f.close()
        spl = line.split(" ")
        worktime = int(spl[2]) + int(spl[3]) + int(spl[4])
        idletime = int(spl[5])
        dworktime = worktime - self.last_worktime
        didletime = idletime - self.last_idletime
        rate = float(dworktime) / (didletime + dworktime)
        self.last_worktime = worktime
        self.last_idletime = idletime
        if self.last_worktime == 0:
            return 0
        return rate

    def get_battery(self):
        voltage = 0.0
        current = 0.0
        charger = False
        charge  = 0.0
        try:
            f = open("/tmp/battery", "r")
            line = f.readline()
            f.close()
            m = re.match(r"(\d+\.\d+)V(\S?)\s+(\d+\.\d+)A\s+(\d+)%", line)
            if m:
                voltage = float(m.group(1))
                charger = m.group(2) == "!"
                current = float(m.group(3))
                charge  = int(m.group(4))
        except:
            pass
        return (voltage, current, charge, charger)

    def add_client(self, c):
        self.clients.append(c)
        with self.startLock:
            if not self.is_alive():
                self.start()

    def remove_client(self, c):
        try:
            self.clients.remove(c)
        except ValueError:
            pass
        if not self.clients:
            self.shutdown()

    def shutdown(self):
        with CpuUsageThread.creationLock:
            CpuUsageThread.sharedInstance = None
        self.doRun = False
        self.endEvent.set()
