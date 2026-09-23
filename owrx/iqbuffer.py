from owrx.source import SdrSourceEventClient, SdrSourceState, SdrClientClass
from owrx.iqrecorder import IqRecorder, makeSigmfCapture, writeSigmfMeta
from owrx.storage import Storage
from owrx.config import Config
from collections import deque
from datetime import datetime, timezone

import threading
import os

import logging

logger = logging.getLogger(__name__)


#
# Keeps the last few seconds of raw IQ data from an SDR source in memory,
# so that users can save what has ALREADY happened (e.g. a signal that
# just went by) into a SigMF recording. One buffer is shared by all users
# of an SDR source. The buffer never keeps an SDR running by itself, it
# only listens while the SDR is running for other reasons.
#
class IqTimeShiftBuffer(SdrSourceEventClient):
    sharedBuffers = {}
    sharedLock = threading.Lock()

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
            return buf

    # Release shared buffer, stopping it when nobody uses it anymore
    @staticmethod
    def release(buf):
        with IqTimeShiftBuffer.sharedLock:
            buf.users -= 1
            if buf.users <= 0:
                buf.stop()
                if IqTimeShiftBuffer.sharedBuffers.get(buf.sdrSource.getId()) is buf:
                    del IqTimeShiftBuffer.sharedBuffers[buf.sdrSource.getId()]

    def __init__(self, sdrSource):
        self.sdrSource  = sdrSource
        self.users      = 0
        self.lock       = threading.Lock()
        self.chunks     = deque()   # (datetime, center_freq, bytes)
        self.size       = 0
        self.sampleRate = 0
        self.reader     = None
        self.thread     = None
        self.subs       = []

    def start(self):
        props = self.sdrSource.getProps()
        self.sampleRate = props["samp_rate"]
        self.subs = [props.filter("samp_rate").wire(self._onSampleRateChange)]
        # This will call onStateChange() with the current state
        self.sdrSource.addClient(self)

    def stop(self):
        while self.subs:
            self.subs.pop().cancel()
        self.sdrSource.removeClient(self)
        self._stopReader()
        self.clear()

    def clear(self):
        with self.lock:
            self.chunks.clear()
            self.size = 0

    def getMaxBytes(self):
        return int(Config.get()["iq_buffer_seconds"] * self.sampleRate * IqRecorder.BYTES_PER_SAMPLE)

    def getDuration(self):
        with self.lock:
            if not self.sampleRate:
                return 0
            return self.size / IqRecorder.BYTES_PER_SAMPLE / self.sampleRate

    def _onSampleRateChange(self, changes):
        if "samp_rate" in changes:
            # Samples at different rates can not be mixed in one file
            self.clear()
            self.sampleRate = changes["samp_rate"]

    def _startReader(self):
        if self.reader is not None:
            return
        self.reader = self.sdrSource.getBuffer().getReader()
        self.thread = threading.Thread(target=self._run, args=(self.reader,), name="iq-timeshift")
        self.thread.start()

    def _stopReader(self):
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
                self.chunks.append((datetime.now(timezone.utc), cf, data))
                self.size += len(data)
                while self.chunks and self.size > maxBytes:
                    self.size -= len(self.chunks.popleft()[2])

    # Save up to the given number of most recent seconds into a new
    # SigMF recording. Returns status dictionary.
    def save(self, seconds: float):
        # Take a snapshot of the data (chunks are immutable)
        wanted = int(seconds * self.sampleRate) * IqRecorder.BYTES_PER_SAMPLE
        with self.lock:
            sampleRate = self.sampleRate
            chunks = []
            total = 0
            for chunk in reversed(self.chunks):
                if total >= wanted:
                    break
                chunks.append(chunk)
                total += len(chunk[2])
            chunks.reverse()

        if not chunks:
            return {"file": None, "size": 0, "seconds": 0, "error": "No IQ data buffered yet"}

        # Start writing at a sample boundary, trimming excess from the front
        excess = total - wanted if total > wanted else 0
        excess -= excess % IqRecorder.BYTES_PER_SAMPLE

        fileName = Storage.makeFileName("IQ-{0}", chunks[0][1]) + ".sigmf-data"
        captures = []
        size = 0
        try:
            with Storage.getSharedInstance().newFile(fileName) as f:
                dataPath = f.name
                for i, (timestamp, cf, data) in enumerate(chunks):
                    if i == 0 and excess > 0:
                        data = data[excess:]
                    if not captures or captures[-1]["core:frequency"] != cf:
                        captures.append(makeSigmfCapture(size // IqRecorder.BYTES_PER_SAMPLE, cf, timestamp))
                    f.write(data)
                    size += len(data)
            writeSigmfMeta(dataPath, sampleRate, captures, self.sdrSource)
        except Exception as e:
            logger.exception("Exception saving IQ buffer")
            return {"file": None, "size": 0, "seconds": 0, "error": str(e)}

        Storage.getSharedInstance().cleanStoredFiles()
        logger.info("Saved %d bytes of buffered IQ to '%s'.", size, dataPath)
        return {
            "file": os.path.basename(dataPath),
            "size": size,
            "seconds": size / IqRecorder.BYTES_PER_SAMPLE / sampleRate,
            "error": None,
        }

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
