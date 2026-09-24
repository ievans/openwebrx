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
