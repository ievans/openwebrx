import threading
from unittest import TestCase
from unittest.mock import patch

from owrx.client import ClientRegistry
from owrx.connection import OpenWebRxReceiverClient
from owrx.property import PropertyLayer, PropertyStack


class FakeSdr(object):
    def __init__(self, onAddClient=None, onAddSpectrumClient=None):
        self.clients = []
        self.spectrumClients = []
        self.onAddClient = onAddClient
        self.onAddSpectrumClient = onAddSpectrumClient

    def addClient(self, c):
        self.clients.append(c)
        if self.onAddClient:
            self.onAddClient(c)

    def removeClient(self, c):
        if c in self.clients:
            self.clients.remove(c)

    def addSpectrumClient(self, c):
        self.spectrumClients.append(c)
        if self.onAddSpectrumClient:
            self.onAddSpectrumClient(c)

    def removeSpectrumClient(self, c):
        if c in self.spectrumClients:
            self.spectrumClients.remove(c)

    def getProps(self):
        return PropertyLayer()


def makeClient(sdr=None, closed=False):
    # skip __init__, which needs a live websocket, config and SDR service
    client = OpenWebRxReceiverClient.__new__(OpenWebRxReceiverClient)
    client.dsp = None
    client.dspLock = threading.Lock()
    client.sdr = sdr
    client.iqBuffer = None
    client.iqLock = threading.Lock()
    client.iqReplay = None
    client.replayLock = threading.Lock()
    client.closed = closed
    client.connectionProperties = {}
    client.stack = PropertyStack()
    return client


class ReceiverClientAfterCloseTest(TestCase):
    def testSetSdrDoesNotRegisterClosedClient(self):
        sdr = FakeSdr()
        client = makeClient(closed=True)
        with patch("owrx.connection.SdrService.getFirstSource", return_value=sdr):
            client.setSdr()
        self.assertEqual(sdr.clients, [])
        self.assertIsNone(client.sdr)

    def testSetSdrUnregistersWhenClosedDuringRegistration(self):
        client = makeClient()
        # simulates close() completing on another thread while addClient() runs
        sdr = FakeSdr(onAddClient=lambda c: setattr(c, "closed", True))
        with patch("owrx.connection.SdrService.getFirstSource", return_value=sdr):
            client.setSdr()
        self.assertEqual(sdr.clients, [])

    def testGetDspReturnsNoneWhenClosed(self):
        client = makeClient(sdr=FakeSdr(), closed=True)
        self.assertIsNone(client.getDsp())
        self.assertIsNone(client.dsp)

    def testSdrAvailableDoesNotStartSpectrumForClosedClient(self):
        sdr = FakeSdr()
        client = makeClient(sdr=sdr, closed=True)
        client.handleSdrAvailable()
        self.assertEqual(sdr.spectrumClients, [])
        self.assertIsNone(client.dsp)

    def testSpectrumClientRemovedWhenClosedDuringRegistration(self):
        sdr = FakeSdr(onAddSpectrumClient=lambda c: setattr(c, "closed", True))
        client = makeClient(sdr=sdr)

        class FakeDsp(object):
            def setProperties(self, props):
                pass

        client.dsp = FakeDsp()
        client.handleSdrAvailable()
        self.assertEqual(sdr.spectrumClients, [])


class ClientRegistryBroadcastTest(TestCase):
    def testClientRemovedDuringBroadcastDoesNotSkipOthers(self):
        registry = ClientRegistry.__new__(ClientRegistry)
        received = []

        class FakeClient(object):
            def __init__(self, name, removeSelf=False):
                self.name = name
                self.removeSelf = removeSelf

            def write_log_message(self, text):
                received.append(self.name)
                if self.removeSelf:
                    registry.clients.remove(self)

        registry.clients = [FakeClient("a"), FakeClient("b", removeSelf=True), FakeClient("c")]
        registry.broadcastAdminMessage("hello")
        self.assertEqual(received, ["a", "b", "c"])


class ReceiverClientIqBufferRaceTest(TestCase):
    # startIqBuffer() and stopIqBuffer() run on different threads: the
    # websocket (profile switch, close), the settings (iq_buffer_seconds)
    # and the SDR (onFail/onShutdown). A buffer acquired by one of them
    # must always be released again, or it keeps its IQ data forever.

    def setUp(self):
        self.acquired = []
        self.released = []
        self.listeners = {}
        self.inAcquire = threading.Event()
        self.proceed = threading.Event()
        test = self

        class FakeBuffer(object):
            pass

        def acquire(sdr):
            buf = FakeBuffer()
            test.acquired.append(buf)
            # Only the first acquire waits, so a second thread can get in
            if len(test.acquired) == 1:
                test.inAcquire.set()
                test.proceed.wait(5)
            return buf

        class FakeReporter(object):
            def add(self, callback, buffer):
                test.listeners[callback] = buffer

            def remove(self, callback):
                test.listeners.pop(callback, None)

        reporter = FakeReporter()
        for p in [
            patch("owrx.connection.Config.get", lambda: {"iq_buffer_seconds": 60}),
            patch("owrx.connection.IqTimeShiftBuffer.acquire", acquire),
            patch("owrx.connection.IqTimeShiftBuffer.release", self.released.append),
            patch("owrx.connection.IqBufferReporter.getSharedInstance", lambda: reporter),
        ]:
            p.start()
            self.addCleanup(p.stop)

    def race(self, client, other):
        first = threading.Thread(target=client.startIqBuffer)
        first.start()
        self.assertTrue(self.inAcquire.wait(5))
        second = threading.Thread(target=other)
        second.start()
        # Give the second thread time to run into the first one
        second.join(0.2)
        self.proceed.set()
        first.join(5)
        second.join(5)

    def testCloseWhileAcquiringReleasesBuffer(self):
        client = makeClient(sdr=FakeSdr())

        def close():
            # What close() does with the buffer
            client.closed = True
            client.stopIqBuffer()

        self.race(client, close)
        self.assertEqual(len(self.acquired), 1)
        self.assertEqual(self.released, self.acquired)
        self.assertIsNone(client.iqBuffer)
        self.assertEqual(self.listeners, {})

    def testConcurrentRestartsDoNotLoseABuffer(self):
        client = makeClient(sdr=FakeSdr())
        self.race(client, client.startIqBuffer)
        self.assertEqual(len(self.acquired), 2)
        # The one still held is the only one not released
        self.assertEqual(len(self.released), 1)
        self.assertIn(client.iqBuffer, self.acquired)
        self.assertNotIn(client.iqBuffer, self.released)
