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


class _OneShotReader(object):
    def __init__(self, data):
        self.data = [data]

    def read(self):
        return self.data.pop() if self.data else None

