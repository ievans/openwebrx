from unittest import TestCase
from unittest.mock import patch
from owrx.iqbuffer import IqTimeShiftBuffer
from owrx.iqreplay import IqReplay, ReplayUnavailable
from owrx.source import SdrSourceState
from test.iq.fakes import FakeSource, samples
import struct
import threading
import time


class FakeDsp(object):
    """Records which input the demodulator is switched to."""
    def __init__(self):
        self.inputs = []

    def setInputReader(self, reader=None):
        self.inputs.append(reader)


class IqReplayTest(TestCase):
    def setUp(self):
        config = {"iq_buffer_seconds": 60, "iq_buffer_memory_percent": 100}
        p = patch("owrx.iqbuffer.Config.get", lambda: config)
        p.start()
        self.addCleanup(p.stop)
        # 4 samples per chunk at 40 samples/s: each chunk is 0.1s long
        self.source = FakeSource(samp_rate=40, state=SdrSourceState.RUNNING)
        self.buffer = IqTimeShiftBuffer.acquire(self.source)
        self.addCleanup(lambda: IqTimeShiftBuffer.release(self.buffer))
        self.dsp = FakeDsp()
        self.stops = []

    def feed(self, *values, interval=0.1):
        reader = self.source.reader
        for v in values:
            done = reader.reads + 1
            reader.queue.put(samples(v, v, v, v))
            self.assertTrue(reader.waitForReads(done))
            time.sleep(interval)

    def replay(self):
        r = IqReplay(self.buffer, self.dsp, self.source, self.stops.append)
        self.addCleanup(r.stop)
        return r

    def readValues(self, reader, count):
        """Read COUNT chunks from the replay, returns (value, time) of each."""
        out = []
        while len(out) < count:
            data = reader.read()
            values = struct.unpack("<%df" % (len(data) // 4), bytes(memoryview(data).cast("B")))
            for i in range(0, len(values), 8):
                out.append((values[i], time.monotonic()))
        return out

    def testReplaysFromRequestedTimeAtOriginalPace(self):
        self.feed(*range(10))                 # chunks 0..9, one every 0.1s
        r = self.replay()
        r.start(0.55)                         # about chunk 5
        reader = self.dsp.inputs[-1]
        self.assertIsNotNone(reader, "demodulator must be switched to the replay")
        # meanwhile, live data keeps arriving
        threading.Thread(target=self.feed, args=(10, 11, 12)).start()
        got = self.readValues(reader, 6)
        values = [v for v, _ in got]
        self.assertIn(values[0], (4.0, 5.0))
        self.assertEqual(values, [values[0] + i for i in range(6)], "consecutive chunks")
        # paced like the original: 5 chunk intervals take about 0.5s
        span = got[-1][1] - got[0][1]
        self.assertAlmostEqual(span, 0.5, delta=0.15)

    def testStopReturnsToLiveInput(self):
        self.feed(1, 2, 3)
        r = self.replay()
        r.start(0.2)
        r.stop()
        self.assertIsNone(self.dsp.inputs[-1])
        self.assertFalse(r.thread.is_alive())
        self.assertEqual(self.stops, [], "stopping on request is not reported as an error")

    def testUnavailableWhenNotBuffered(self):
        with self.assertRaises(ReplayUnavailable):
            self.replay().start(1)            # nothing buffered yet
        self.feed(1, 2, 3)
        with self.assertRaises(ReplayUnavailable):
            self.replay().start(30)           # longer ago than the buffer
        self.assertEqual(self.dsp.inputs, [], "demodulator must stay on live input")

    def testUnavailableFromDifferentBand(self):
        self.feed(1, 2, 3)
        self.source.props["center_freq"] = 146000000
        with self.assertRaises(ReplayUnavailable):
            self.replay().start(0.25)

    def testStopsOnRetune(self):
        self.feed(*range(5))
        r = self.replay()
        r.start(0.45)
        self.source.props["center_freq"] = 146000000
        r.thread.join(3)
        self.assertEqual(self.stops, ["Center frequency changed"])
        self.assertIsNone(self.dsp.inputs[-1])

    def testStopsWhenDataStops(self):
        self.feed(1, 2)
        r = self.replay()
        with patch.object(IqReplay, "STALL_TIMEOUT", 0.3):
            r.start(0.15)
            self.buffer.clear()
            r.thread.join(3)
        self.assertFalse(r.thread.is_alive())
        self.assertEqual(len(self.stops), 1)
        self.assertIsNone(self.dsp.inputs[-1])


class TimeShiftBufferLookupTest(TestCase):
    def setUp(self):
        config = {"iq_buffer_seconds": 60, "iq_buffer_memory_percent": 100}
        p = patch("owrx.iqbuffer.Config.get", lambda: config)
        p.start()
        self.addCleanup(p.stop)
        self.source = FakeSource(samp_rate=40, state=SdrSourceState.RUNNING)
        self.buffer = IqTimeShiftBuffer.acquire(self.source)
        self.addCleanup(lambda: IqTimeShiftBuffer.release(self.buffer))

    def testFindAndGetChunk(self):
        reader = self.source.reader
        for v in range(5):
            done = reader.reads + 1
            reader.queue.put(samples(v, v, v, v))
            reader.waitForReads(done)
            time.sleep(0.1)
        seq = self.buffer.findChunk(0.25)
        chunk = self.buffer.getChunk(seq)
        self.assertIn(struct.unpack("<f", chunk[2][:4])[0], (2.0, 3.0))
        self.assertIsNone(self.buffer.getChunk(seq + 100), "not arrived yet")
        self.buffer.clear()
        reader.queue.put(samples(9, 9, 9, 9))
        reader.waitForReads(reader.reads + 1)
        with self.assertRaises(LookupError):
            self.buffer.getChunk(seq)
