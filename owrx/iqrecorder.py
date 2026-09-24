from owrx.source import SdrSourceEventClient, SdrSourceState, SdrClientClass
from owrx.storage import Storage
from owrx.version import openwebrx_version
from datetime import datetime, timezone

import threading
import json
import os

import logging

logger = logging.getLogger(__name__)


def makeSigmfCapture(sampleStart: int, frequency: int, timestamp: datetime = None):
    if timestamp is None:
        timestamp = datetime.now(timezone.utc)
    return {
        "core:sample_start": sampleStart,
        "core:frequency": frequency,
        "core:datetime": timestamp.strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
    }


# Write SigMF metadata file next to the given .sigmf-data file
def writeSigmfMeta(dataPath: str, sampleRate: int, captures: list, sdrSource):
    metaPath = dataPath[:-len(".sigmf-data")] + ".sigmf-meta"
    meta = {
        "global": {
            "core:datatype": "cf32_le",
            "core:sample_rate": sampleRate,
            "core:version": "1.0.0",
            "core:recorder": "OpenWebRX+ {0}".format(openwebrx_version),
            "core:hw": sdrSource.getName(),
            "core:description": "{0} / {1}".format(
                sdrSource.getName(), sdrSource.getProfileName()
            ),
        },
        "captures": captures,
        "annotations": [],
    }
    with open(metaPath, "w") as f:
        json.dump(meta, f, indent=2)


#
# Records raw IQ samples coming from an SDR source into a SigMF recording
# (.sigmf-data file with complex float32 samples, plus .sigmf-meta file
# with JSON metadata). Center frequency changes during recording are noted
# as separate SigMF capture segments. Recordings can be replayed later
# with the "IQ File" SDR source, or with any SigMF-aware tool.
#
class IqRecorder(SdrSourceEventClient):
    # Only one IQ recording per SDR source at a time, to protect disk I/O
    activeRecorders = {}
    registryLock = threading.Lock()

    # Complex float32 samples: 2 x 4 bytes
    BYTES_PER_SAMPLE = 8

    def __init__(self, sdrSource, maxBytes: int, onStop=None):
        self.sdrSource = sdrSource
        self.maxBytes  = maxBytes
        self.onStop    = onStop
        self.lock      = threading.Lock()
        self.file      = None
        self.reader    = None
        self.thread    = None
        self.running   = False
        self.error     = None
        self.size      = 0
        self.captures  = []
        self.subs      = []
        self.sampleRate = 0
        self.dataPath  = None

    @staticmethod
    def getRecorder(sdrSource):
        with IqRecorder.registryLock:
            return IqRecorder.activeRecorders.get(sdrSource.getId())

    def getFileName(self):
        return os.path.basename(self.dataPath) if self.dataPath else None

    def getStatus(self):
        return {
            "recording": self.running,
            "file": self.getFileName(),
            "size": self.size,
            "error": self.error,
        }

    def start(self):
        if not self.sdrSource.isAvailable():
            raise RuntimeError("SDR source is not running")

        with IqRecorder.registryLock:
            if self.sdrSource.getId() in IqRecorder.activeRecorders:
                raise RuntimeError("This SDR is already being recorded")
            IqRecorder.activeRecorders[self.sdrSource.getId()] = self

        try:
            props = self.sdrSource.getProps()
            self.sampleRate = props["samp_rate"]
            centerFreq = props["center_freq"]
            self.captures = [self._makeCapture(0, centerFreq)]

            fileName = Storage.makeFileName("IQ-{0}", centerFreq) + ".sigmf-data"
            self.file = Storage.getSharedInstance().newFile(fileName)
            self.dataPath = self.file.name

            self.reader = self.sdrSource.getBuffer().getReader()
            self.running = True
            self.sdrSource.addClient(self)
            # Not props.filter(), which would stay wired after cancel()
            self.subs = [
                props.wire(self._onCenterFreqChange),
                props.wire(self._onSampleRateChange),
            ]
            self.thread = threading.Thread(target=self._run, name="iq-recorder")
            self.thread.start()
            logger.info("Started IQ recording to '%s'.", self.dataPath)
        except Exception:
            self._cleanup()
            raise

    def stop(self, error: str = None):
        with self.lock:
            if not self.running:
                return
            self.running = False
            if error is not None:
                self.error = error
        reader = self.reader
        if reader is not None:
            reader.stop()

    def _makeCapture(self, sampleStart: int, frequency: int):
        return makeSigmfCapture(sampleStart, frequency)

    def _onCenterFreqChange(self, changes):
        if "center_freq" not in changes:
            return
        with self.lock:
            sample = self.size // IqRecorder.BYTES_PER_SAMPLE
            capture = self._makeCapture(sample, changes["center_freq"])
            # Replace capture segment that has no samples yet
            if self.captures and self.captures[-1]["core:sample_start"] == sample:
                self.captures[-1] = capture
            else:
                self.captures.append(capture)

    def _onSampleRateChange(self, changes):
        # SigMF can not represent sample rate changes within one recording
        if "samp_rate" in changes and changes["samp_rate"] != self.sampleRate:
            self.stop("Sample rate changed")

    def _run(self):
        try:
            while self.running:
                data = self.reader.read()
                if data is None:
                    break
                # Work in bytes, not in typed elements
                data = memoryview(data).cast("B")
                # Only write whole samples
                room = self.maxBytes - self.size
                room -= room % IqRecorder.BYTES_PER_SAMPLE
                if len(data) > room:
                    data = data[:room]
                self.file.write(data)
                with self.lock:
                    self.size += len(data)
                # Stop when there is no room left for another sample
                if self.maxBytes - self.size < IqRecorder.BYTES_PER_SAMPLE:
                    logger.info("IQ recording reached size limit.")
                    break
        except Exception as e:
            logger.exception("Exception while recording IQ data")
            self.error = str(e)
        finally:
            self.running = False
            self._cleanup()
            if self.onStop is not None:
                try:
                    self.onStop(self.getStatus())
                except Exception:
                    logger.exception("Exception reporting IQ recording status")

    def _writeMeta(self):
        writeSigmfMeta(self.dataPath, self.sampleRate, self.captures, self.sdrSource)

    def _cleanup(self):
        while self.subs:
            self.subs.pop().cancel()
        self.sdrSource.removeClient(self)
        reader, self.reader = self.reader, None
        if reader is not None:
            reader.stop()
        if self.file is not None:
            try:
                self.file.close()
                self._writeMeta()
                logger.info("Finished IQ recording '%s' (%d bytes).", self.dataPath, self.size)
            except Exception as e:
                logger.error("Exception closing IQ recording: %s", str(e))
            self.file = None
            # Delete excessive files from storage
            Storage.getSharedInstance().cleanStoredFiles()
        with IqRecorder.registryLock:
            if IqRecorder.activeRecorders.get(self.sdrSource.getId()) is self:
                del IqRecorder.activeRecorders[self.sdrSource.getId()]

    # SdrSourceEventClient interface

    def getClientClass(self) -> SdrClientClass:
        return SdrClientClass.USER

    def onStateChange(self, state: SdrSourceState):
        if state is SdrSourceState.STOPPING:
            self.stop("SDR source stopped")

    def onFail(self):
        self.stop("SDR source failed")

    def onShutdown(self):
        self.stop("SDR source shut down")

    def onDisable(self):
        self.stop("SDR source disabled")
