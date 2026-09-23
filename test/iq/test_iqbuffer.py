from unittest import TestCase
from unittest.mock import patch
from owrx.iqbuffer import IqTimeShiftBuffer
from owrx.source import SdrSourceState, SdrClientClass
from owrx.storage import Storage
from test.iq.fakes import FakeSource
from test.iq.test_iqrecorder import samples
import json
import os
import struct
import tempfile


class IqTimeShiftBufferTest(TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        config = {"iq_buffer_seconds": 2}
        patches = [
            patch.object(Storage, "getFilePath", staticmethod(lambda f: os.path.join(self.dir.name, f))),
            patch.object(Storage, "cleanStoredFiles", lambda self: None),
            patch("owrx.iqbuffer.Config.get", lambda: config),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.dir.cleanup)
        # 4 samples per second, so 2 seconds = 8 samples = 64 bytes
        self.source = FakeSource(samp_rate=4, state=SdrSourceState.RUNNING)

    def acquire(self):
        buf = IqTimeShiftBuffer.acquire(self.source)
        self.addCleanup(lambda: IqTimeShiftBuffer.release(buf) if buf.users > 0 else None)
        return buf

    def feed(self, buf, *chunks):
        reader = self.source.reader
        for c in chunks:
            # The chunk is fully processed once the buffer asks for the next one
            done = reader.reads + 1
            reader.queue.put(c)
            self.assertTrue(reader.waitForReads(done), "buffer did not process data")

    def testSharedPassiveClient(self):
        a = self.acquire()
        b = self.acquire()
        self.assertIs(a, b)
        self.assertEqual(a.users, 2)
        self.assertEqual(a.getClientClass(), SdrClientClass.INACTIVE)

    def testKeepsOnlyConfiguredDuration(self):
        buf = self.acquire()
        self.feed(buf, *[samples(v, v, v, v) for v in range(5)])
        self.assertEqual(buf.size, 64)
        self.assertEqual(buf.getDuration(), 2.0)

    def testSaveWritesNewestSecondsAtSampleBoundary(self):
        buf = self.acquire()
        self.feed(buf, *[samples(v, v, v, v) for v in range(5)])
        status = buf.save(1.5)
        self.assertIsNone(status["error"])
        self.assertEqual(status["size"], 48)
        self.assertEqual(status["seconds"], 1.5)
        with open(os.path.join(self.dir.name, status["file"]), "rb") as f:
            data = f.read()
        values = struct.unpack("<%df" % (len(data) // 4), data)
        # last 6 samples: 2 samples of chunk 3, then all of chunk 4
        self.assertEqual(values, (3.0,) * 4 + (4.0,) * 8)
        with open(os.path.join(self.dir.name, status["file"].replace("data", "meta"))) as f:
            meta = json.load(f)
        self.assertEqual(meta["global"]["core:sample_rate"], 4)

    def testSaveMarksRetunes(self):
        buf = self.acquire()
        self.feed(buf, samples(1, 1, 1, 1))
        self.source.props["center_freq"] = 146000000
        self.feed(buf, samples(2, 2, 2, 2))
        status = buf.save(2)
        with open(os.path.join(self.dir.name, status["file"].replace("data", "meta"))) as f:
            captures = json.load(f)["captures"]
        self.assertEqual([(c["core:sample_start"], c["core:frequency"]) for c in captures], [(0, 145000000), (4, 146000000)])

    def testOnlyOneSaveAtATime(self):
        buf = self.acquire()
        self.feed(buf, samples(1, 1, 1, 1))
        buf.saveLock.acquire()
        try:
            self.assertEqual(buf.save(1)["error"], "Already saving IQ buffer")
        finally:
            buf.saveLock.release()

    def testEmptySave(self):
        buf = self.acquire()
        self.assertEqual(buf.save(1)["error"], "No IQ data buffered yet")

    def testSampleRateChangeClears(self):
        buf = self.acquire()
        self.feed(buf, samples(1, 1, 1, 1))
        self.source.props["samp_rate"] = 8
        self.assertEqual(buf.size, 0)

    def testLastReleaseDetaches(self):
        buf = IqTimeShiftBuffer.acquire(self.source)
        IqTimeShiftBuffer.acquire(self.source)
        IqTimeShiftBuffer.release(buf)
        self.assertIsNotNone(buf.reader)
        IqTimeShiftBuffer.release(buf)
        self.assertIsNone(buf.reader)
        self.assertNotIn(buf, self.source.clients)
        self.assertNotIn(self.source.getId(), IqTimeShiftBuffer.sharedBuffers)
