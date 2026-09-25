from unittest import TestCase
from unittest.mock import patch
from owrx.iqbuffer import IqTimeShiftBuffer
from owrx.source import SdrSourceState, SdrClientClass
from test.iq.fakes import FakeSource, samples


class IqTimeShiftBufferTest(TestCase):
    def setUp(self):
        self.config = {"iq_buffer_seconds": 2, "iq_buffer_memory_percent": 100}
        p = patch("owrx.iqbuffer.Config.get", lambda: self.config)
        p.start()
        self.addCleanup(p.stop)
        # Plenty of memory, unless a test says otherwise
        self.memoryTotal = 1 << 30
        p = patch("owrx.iqbuffer.IqTimeShiftBuffer._getMemoryTotal", lambda: self.memoryTotal)
        p.start()
        self.addCleanup(p.stop)
        # 4 samples per second, so 2 seconds = 8 samples = 64 bytes
        self.source = FakeSource(samp_rate=4, state=SdrSourceState.RUNNING)

    def acquire(self, source=None):
        buf = IqTimeShiftBuffer.acquire(source or self.source)
        self.addCleanup(lambda: IqTimeShiftBuffer.release(buf) if buf.users > 0 else None)
        return buf

    def feed(self, buf, *chunks):
        reader = buf.sdrSource.reader
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

    def testSwitchingDoesNotLeakPropertySubscriptions(self):
        # Every switch away from and back to an SDR stops and restarts
        # the buffer; nothing must stay wired to the SDR's properties
        before = len(self.source.props.subscribers)
        for _ in range(5):
            buf = IqTimeShiftBuffer.acquire(self.source)
            self.source.props["center_freq"] = 146000000
            IqTimeShiftBuffer.release(buf)
        self.assertEqual(len(self.source.props.subscribers), before)

    def testLateRunningEventAfterReleaseDoesNotRestart(self):
        # The SDR delivers state events to a copy of its client list, so
        # RUNNING can arrive after the last user released the buffer (e.g.
        # a user closing the page while the SDR starts up). That must not
        # bring the discarded buffer back to life.
        self.source.state = SdrSourceState.STARTING
        buf = IqTimeShiftBuffer.acquire(self.source)
        IqTimeShiftBuffer.release(buf)
        buf.onStateChange(SdrSourceState.RUNNING)
        self.assertIsNone(buf.reader)
        self.assertIsNone(buf.thread)

    def testStoppedReaderDoesNotStoreLateChunk(self):
        buf = self.acquire()
        buf._stopReader()
        # A chunk that a reader which is no longer current still returns
        buf._run(_OneShotReader(samples(1, 1)))
        self.assertEqual(buf.size, 0)


    def testMemoryLimitShortensBuffer(self):
        # 32 of 100 bytes: room for 1 of the 2 configured seconds
        self.memoryTotal = 100
        self.config["iq_buffer_memory_percent"] = 32
        buf = self.acquire()
        self.feed(buf, *[samples(v, v, v, v) for v in range(5)])
        self.assertEqual(buf.size, 32)
        status = buf.getStatus()
        self.assertEqual(status["max_seconds"], 1.0)
        self.assertTrue(status["memory_limited"])

    def testSecondsLimitWhenMemoryAllows(self):
        # 50 of 1000 bytes is more than the 64 bytes 2 seconds need
        self.memoryTotal = 1000
        self.config["iq_buffer_memory_percent"] = 50
        buf = self.acquire()
        self.feed(buf, *[samples(v, v, v, v) for v in range(5)])
        self.assertEqual(buf.size, 64)
        self.assertFalse(buf.getStatus()["memory_limited"])

    def testUnknownMemoryMeansNoLimit(self):
        self.memoryTotal = None
        self.config["iq_buffer_memory_percent"] = 1
        buf = self.acquire()
        self.assertEqual(buf.getMaxBytes(), 64)

    def testSdrsShareTheMemoryLimit(self):
        # 96 bytes for all: one buffer alone gets its full 64
        # Chunks of 16 bytes, so that sizes are not rounded to chunks
        self.memoryTotal = 96
        a = self.acquire()
        self.feed(a, *[samples(v, v) for v in range(5)])
        self.assertEqual(a.size, 64)
        # A second SDR at the same rate: 48 each, and the first one
        # shrinks right away, without waiting for more data
        other = FakeSource(samp_rate=4, state=SdrSourceState.RUNNING, id="other")
        b = self.acquire(other)
        self.assertEqual(a.getMaxBytes(), 48)
        self.assertEqual(b.getMaxBytes(), 48)
        self.assertEqual(a.size, 48)
        self.feed(b, *[samples(v, v) for v in range(5)])
        self.assertEqual(b.size, 48)
        # Once the second SDR is gone, the first one may grow again
        IqTimeShiftBuffer.release(b)
        self.assertEqual(a.getMaxBytes(), 64)

    def testSmallBufferLeavesRestOfMemoryToOthers(self):
        # 2 seconds at 2 samples/s need 32 bytes, leaving 64 of 96 bytes,
        # which is all that the 4 samples/s buffer needs
        self.memoryTotal = 96
        a = self.acquire()
        b = self.acquire(FakeSource(samp_rate=2, state=SdrSourceState.RUNNING, id="slow"))
        self.assertEqual(b.getMaxBytes(), 32)
        self.assertEqual(a.getMaxBytes(), 64)
        # With 80 bytes, the small one still fits, the big one gets the rest
        self.memoryTotal = 80
        self.assertEqual(b.getMaxBytes(), 32)
        self.assertEqual(a.getMaxBytes(), 48)
        # With 40, neither fits: equal shares
        self.memoryTotal = 40
        self.assertEqual(a.getMaxBytes(), 20)
        self.assertEqual(b.getMaxBytes(), 20)


class _OneShotReader(object):
    def __init__(self, data):
        self.data = [data]

    def read(self):
        return self.data.pop() if self.data else None

