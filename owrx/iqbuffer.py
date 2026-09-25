from owrx.source import SdrSourceEventClient, SdrSourceState, SdrClientClass
from owrx.config import Config
from owrx.cpu import CpuUsageThread
from collections import deque
from datetime import datetime, timezone

import threading
import time

import logging

logger = logging.getLogger(__name__)


#
# Keeps the last few seconds of raw IQ data from an SDR source in memory,
# so that users can rewind and listen anywhere in the spectrum in the
# past (see IqReplay). One buffer is shared by all users of an SDR source. The buffer never keeps an SDR running by itself, it
# only listens while the SDR is running for other reasons.
#
# Each buffer keeps iq_buffer_seconds of data, but all buffers together
# never use more than iq_buffer_memory_percent of the server's memory.
#
class IqTimeShiftBuffer(SdrSourceEventClient):
    sharedBuffers = {}
    sharedLock = threading.Lock()
    # Buffers currently started, which share the memory limit
    activeBuffers = []
    # Complex float32 samples
    BYTES_PER_SAMPLE = 8
    # How often to look up the server's total memory again
    MEMORY_CHECK_INTERVAL = 10.0
    memoryTotal = None
    memoryChecked = None

    # Acquire shared buffer for the given SDR source
    @staticmethod
    def acquire(sdrSource):
        with IqTimeShiftBuffer.sharedLock:
            buf = IqTimeShiftBuffer.sharedBuffers.get(sdrSource.getId())
            if buf is None or buf.sdrSource is not sdrSource:
                buf = IqTimeShiftBuffer(sdrSource)
                IqTimeShiftBuffer.sharedBuffers[sdrSource.getId()] = buf
            buf.users += 1
            if buf.users == 1:
                buf.start()
                IqTimeShiftBuffer.activeBuffers.append(buf)
                # The others now have less memory to share
                IqTimeShiftBuffer._trimAll()
            return buf

    # Release shared buffer, stopping it when nobody uses it anymore
    @staticmethod
    def release(buf):
        with IqTimeShiftBuffer.sharedLock:
            buf.users -= 1
            if buf.users <= 0:
                if buf in IqTimeShiftBuffer.activeBuffers:
                    IqTimeShiftBuffer.activeBuffers.remove(buf)
                buf.stop()
                if IqTimeShiftBuffer.sharedBuffers.get(buf.sdrSource.getId()) is buf:
                    del IqTimeShiftBuffer.sharedBuffers[buf.sdrSource.getId()]

    def __init__(self, sdrSource):
        self.sdrSource  = sdrSource
        self.users      = 0
        self.lock       = threading.Lock()
        # Chunk = (datetime, center_freq, bytes, monotonic time, sequence number)
        self.chunks     = deque()
        self.seq        = 0         # sequence number of the next chunk
        self.size       = 0
        self.sampleRate = 0
        self.reader     = None
        self.thread     = None
        self.subs       = []
        # Guards reader and stopped: SDR state events arrive on the SDR's
        # own threads, concurrently with release() on a client's thread
        self.readerLock = threading.Lock()
        self.stopped    = False

    def start(self):
        props = self.sdrSource.getProps()
        self.sampleRate = props["samp_rate"]
        # Wire to the properties directly: a props.filter() stays wired to
        # the SDR properties even after its subscription is cancelled, so
        # it would leak on every SDR switch
        self.subs = [props.wire(self._onSampleRateChange)]
        # This will call onStateChange() with the current state
        self.sdrSource.addClient(self)

    def stop(self):
        # The SDR hands state events to a copy of its client list, so one
        # may still reach us after removeClient(). Without this flag a late
        # RUNNING would start a reader on this discarded buffer, which then
        # fills up forever next to the buffer that replaced it.
        with self.readerLock:
            self.stopped = True
        while self.subs:
            self.subs.pop().cancel()
        self.sdrSource.removeClient(self)
        self._stopReader()
        self.clear()

    def clear(self):
        with self.lock:
            self.chunks.clear()
            self.size = 0

    # Bytes needed to hold iq_buffer_seconds at the current sample rate
    def getWantedBytes(self):
        return int(Config.get()["iq_buffer_seconds"] * self.sampleRate * IqTimeShiftBuffer.BYTES_PER_SAMPLE)

    # Size limit of this buffer: iq_buffer_seconds, unless that does not
    # fit into its share of the memory limit
    def getMaxBytes(self):
        wanted = self.getWantedBytes()
        limit = IqTimeShiftBuffer.getMemoryLimit()
        if limit is None:
            return wanted
        return min(wanted, self._getMemoryShare(limit))

    # This buffer's share of LIMIT bytes among all active buffers. A buffer
    # that needs less than an equal share leaves the rest to the others.
    def _getMemoryShare(self, limit):
        mine = self.getWantedBytes()
        wants = sorted([b.getWantedBytes() for b in list(IqTimeShiftBuffer.activeBuffers) if b is not self] + [mine])
        remaining = limit
        for i, wanted in enumerate(wants):
            share = remaining // (len(wants) - i)
            if wanted >= share:
                # Neither this nor any bigger buffer fits: all get the same
                return share
            if wanted == mine:
                return mine
            remaining -= wanted
        return mine

    # Bytes all buffers together may use, or None if unlimited
    @staticmethod
    def getMemoryLimit():
        total = IqTimeShiftBuffer._getMemoryTotal()
        if not total:
            return None
        return int(total * Config.get()["iq_buffer_memory_percent"] / 100)

    # Total server memory in bytes (the container limit, if there is one),
    # or None if unknown. Cached, since it is needed for every chunk.
    @staticmethod
    def _getMemoryTotal():
        now = time.monotonic()
        checked = IqTimeShiftBuffer.memoryChecked
        if checked is None or now - checked > IqTimeShiftBuffer.MEMORY_CHECK_INTERVAL:
            memory = CpuUsageThread.get_memory()
            IqTimeShiftBuffer.memoryTotal = memory["total"] if memory else None
            IqTimeShiftBuffer.memoryChecked = now
        return IqTimeShiftBuffer.memoryTotal

    # Drop the oldest data of all active buffers that are over their limit
    @staticmethod
    def _trimAll():
        for buf in list(IqTimeShiftBuffer.activeBuffers):
            maxBytes = buf.getMaxBytes()
            with buf.lock:
                buf._trim(maxBytes)

    # Must be called with self.lock held
    def _trim(self, maxBytes):
        while self.chunks and self.size > maxBytes:
            self.size -= len(self.chunks.popleft()[2])

    # Fill level, for display: buffered and maximum seconds and bytes
    def getStatus(self):
        maxBytes = self.getMaxBytes()
        with self.lock:
            size = self.size
            rate = self.sampleRate
        perSecond = rate * IqTimeShiftBuffer.BYTES_PER_SAMPLE
        return {
            "seconds": size / perSecond if perSecond else 0,
            "max_seconds": maxBytes / perSecond if perSecond else 0,
            "bytes": size,
            "max_bytes": maxBytes,
            # Holds fewer than iq_buffer_seconds because of the memory limit
            "memory_limited": maxBytes < self.getWantedBytes(),
            "samp_rate": rate,
        }

    def getDuration(self):
        with self.lock:
            if not self.sampleRate:
                return 0
            return self.size / IqTimeShiftBuffer.BYTES_PER_SAMPLE / self.sampleRate

    def _onSampleRateChange(self, changes):
        if "samp_rate" in changes:
            # Samples at different rates can not be mixed
            self.clear()
            self.sampleRate = changes["samp_rate"]

    def _startReader(self):
        with self.readerLock:
            if self.reader is not None or self.stopped:
                return
            self.reader = self.sdrSource.getBuffer().getReader()
            self.thread = threading.Thread(target=self._run, args=(self.reader,), name="iq-timeshift")
            self.thread.start()

    def _stopReader(self):
        with self.readerLock:
            reader, self.reader = self.reader, None
        if reader is not None:
            reader.stop()

    def _run(self, reader):
        while True:
            data = reader.read()
            if data is None:
                break
            # Must copy data, since the reader reuses its memory
            data = bytes(memoryview(data).cast("B"))
            cf = self.sdrSource.getProps()["center_freq"]
            maxBytes = self.getMaxBytes()
            with self.lock:
                # A reader that has been stopped may still return one last
                # chunk, which must not end up in a cleared buffer
                if reader is not self.reader:
                    break
                self.chunks.append((datetime.now(timezone.utc), cf, data, time.monotonic(), self.seq))
                self.seq += 1
                self.size += len(data)
                self._trim(maxBytes)

    # Find the chunk holding the samples received the given number of
    # seconds ago. Returns its sequence number, or None if not buffered.
    def findChunk(self, age: float):
        target = time.monotonic() - age
        with self.lock:
            if not self.chunks:
                return None
            # A chunk's time is when its last sample arrived, so allow the
            # first chunk to cover a little time before it
            first = self.chunks[0]
            if target < first[3] - len(first[2]) / IqTimeShiftBuffer.BYTES_PER_SAMPLE / max(self.sampleRate, 1):
                return None
            lo, hi = 0, len(self.chunks) - 1
            while lo < hi:
                mid = (lo + hi) // 2
                if self.chunks[mid][3] < target:
                    lo = mid + 1
                else:
                    hi = mid
            return self.chunks[lo][4]

    # Get chunk by its sequence number. Returns None if it has not arrived
    # yet, raises LookupError if it has already been dropped.
    def getChunk(self, seq: int):
        with self.lock:
            if not self.chunks or seq > self.chunks[-1][4]:
                return None
            index = seq - self.chunks[0][4]
            if index < 0:
                raise LookupError("IQ data no longer buffered")
            return self.chunks[index]

    # SdrSourceEventClient interface

    def getClientClass(self) -> SdrClientClass:
        # Do not keep the SDR running just for the buffer
        return SdrClientClass.INACTIVE

    def onStateChange(self, state: SdrSourceState):
        if state == SdrSourceState.RUNNING:
            self._startReader()
        elif state is SdrSourceState.STOPPING:
            self._stopReader()

    def onFail(self):
        self._stopReader()

    def onShutdown(self):
        self._stopReader()

    def onDisable(self):
        self._stopReader()


#
# Periodically sends the fill level of their IQ time-shift buffer to
# interested clients. One thread serves all of them.
#
class IqBufferReporter(object):
    sharedInstance = None
    creationLock = threading.Lock()
    INTERVAL = 1.0

    @staticmethod
    def getSharedInstance():
        with IqBufferReporter.creationLock:
            if IqBufferReporter.sharedInstance is None:
                IqBufferReporter.sharedInstance = IqBufferReporter()
        return IqBufferReporter.sharedInstance

    def __init__(self):
        self.lock = threading.Lock()
        self.listeners = {}     # callback -> buffer
        self.thread = None

    # Report status of BUFFER to CALLBACK until removed
    def add(self, callback, buffer):
        with self.lock:
            self.listeners[callback] = buffer
            if self.thread is None:
                self.thread = threading.Thread(target=self._run, name="iq-buffer-reporter", daemon=True)
                self.thread.start()

    def remove(self, callback):
        with self.lock:
            self.listeners.pop(callback, None)

    def _run(self):
        while True:
            with self.lock:
                if not self.listeners:
                    self.thread = None
                    return
                listeners = list(self.listeners.items())
            for callback, buffer in listeners:
                try:
                    callback(buffer.getStatus())
                except Exception:
                    logger.exception("Exception reporting IQ buffer status")
            time.sleep(IqBufferReporter.INTERVAL)
