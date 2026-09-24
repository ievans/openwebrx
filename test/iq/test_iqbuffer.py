from unittest import TestCase
from unittest.mock import patch
from owrx.iqbuffer import IqTimeShiftBuffer
from owrx.source import SdrSourceState, SdrClientClass
from test.iq.fakes import FakeSource, samples


class IqTimeShiftBufferTest(TestCase):
    def setUp(self):
        config = {"iq_buffer_seconds": 2}
        p = patch("owrx.iqbuffer.Config.get", lambda: config)
        p.start()
        self.addCleanup(p.stop)
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
