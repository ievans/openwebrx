from unittest import TestCase
from unittest.mock import patch
from owrx.iqrecorder import IqRecorder
from owrx.source import SdrSourceState
from owrx.storage import Storage
from test.iq.fakes import FakeSource
import json
import os
import re
import struct
import tempfile
import time


def samples(*values):
    """Complex float32 samples with I = Q = value, as a typed memoryview."""
    data = struct.pack("<%df" % (2 * len(values)), *[v for v in values for _ in (0, 1)])
    return memoryview(data).cast("f")


class IqRecorderTest(TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        patches = [
            patch.object(Storage, "getFilePath", staticmethod(lambda f: os.path.join(self.dir.name, f))),
            patch.object(Storage, "cleanStoredFiles", lambda self: None),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.dir.cleanup)
        self.statuses = []

    def record(self, source, maxBytes=10 ** 9):
        recorder = IqRecorder(source, maxBytes, self.statuses.append)
        recorder.start()

        def cleanup():
            # The recorder unregisters itself from its own thread, wait for
            # that, or the next test would find the fake SDR still recording
            recorder.stop()
            recorder.thread.join(5)
        self.addCleanup(cleanup)
        return recorder

    def waitForSize(self, recorder, size):
        deadline = time.time() + 5
        while recorder.size < size and time.time() < deadline:
            time.sleep(0.01)

    def readMeta(self, recorder):
        with open(recorder.dataPath[:-len(".sigmf-data")] + ".sigmf-meta") as f:
            return json.load(f)

    def testRecordsSamplesAndMetadata(self):
        source = FakeSource(samp_rate=2400000)
        recorder = self.record(source)
        source.reader.queue.put(samples(1, 2, 3, 4))
        self.waitForSize(recorder, 32)
        recorder.stop()
        recorder.thread.join(5)

        with open(recorder.dataPath, "rb") as f:
            self.assertEqual(f.read(), bytes(samples(1, 2, 3, 4).cast("B")))
        meta = self.readMeta(recorder)
        self.assertEqual(meta["global"]["core:datatype"], "cf32_le")
        self.assertEqual(meta["global"]["core:sample_rate"], 2400000)
        self.assertEqual([(c["core:sample_start"], c["core:frequency"]) for c in meta["captures"]], [(0, 145000000)])
        self.assertTrue(re.match(Storage.getNamePattern(), os.path.basename(recorder.dataPath)))
        self.assertEqual(self.statuses[-1]["recording"], False)
        self.assertEqual(self.statuses[-1]["size"], 32)

    def testRetuneStartsNewCaptureSegment(self):
        source = FakeSource()
        recorder = self.record(source)
        source.reader.queue.put(samples(1, 2, 3, 4))
        self.waitForSize(recorder, 32)
        source.props["center_freq"] = 146000000
        source.reader.queue.put(samples(5, 6))
        self.waitForSize(recorder, 48)
        recorder.stop()
        recorder.thread.join(5)
        captures = self.readMeta(recorder)["captures"]
        self.assertEqual([(c["core:sample_start"], c["core:frequency"]) for c in captures], [(0, 145000000), (4, 146000000)])

    def testOnlyOneRecordingPerSource(self):
        source = FakeSource()
        self.record(source)
        with self.assertRaises(RuntimeError):
            IqRecorder(source, 10 ** 9).start()

    def testSizeLimitCutsAtSampleBoundary(self):
        # 20 bytes is not a whole number of samples, must stop at 16
        source = FakeSource()
        recorder = self.record(source, maxBytes=20)
        source.reader.queue.put(samples(1, 2, 3, 4))
        recorder.thread.join(5)
        self.assertFalse(recorder.thread.is_alive())
        self.assertEqual(os.path.getsize(recorder.dataPath), 16)
        self.assertFalse(self.statuses[-1]["recording"])

    def testStopsWhenSdrStops(self):
        source = FakeSource()
        recorder = self.record(source)
        recorder.onStateChange(SdrSourceState.STOPPING)
        recorder.thread.join(5)
        self.assertEqual(self.statuses[-1]["error"], "SDR source stopped")
        self.assertNotIn(recorder, source.clients)
        self.assertIsNone(IqRecorder.getRecorder(source))

    def testDoesNotLeakPropertySubscriptions(self):
        source = FakeSource()
        before = len(source.props.subscribers)
        for _ in range(3):
            recorder = IqRecorder(source, 10 ** 9, self.statuses.append)
            recorder.start()
            source.props["center_freq"] = 146000000
            recorder.stop()
            recorder.thread.join(5)
        self.assertEqual(len(source.props.subscribers), before)

    def testStopsOnSampleRateChange(self):
        source = FakeSource()
        recorder = self.record(source)
        source.props["samp_rate"] = 8
        recorder.thread.join(5)
        self.assertEqual(self.statuses[-1]["error"], "Sample rate changed")
