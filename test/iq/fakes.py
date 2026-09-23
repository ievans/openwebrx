from owrx.property import PropertyLayer
import queue
import threading


class FakeReader(object):
    """Stands in for a pycsdr reader: tests push chunks, read() returns them."""
    def __init__(self):
        self.queue = queue.Queue()
        self.reads = 0
        self.lock = threading.Condition()

    def read(self):
        # A new read() means everything read before has been processed
        with self.lock:
            self.reads += 1
            self.lock.notify_all()
        return self.queue.get(timeout=5)

    def waitForReads(self, count, timeout=5):
        with self.lock:
            return self.lock.wait_for(lambda: self.reads >= count, timeout)

    def stop(self):
        self.queue.put(None)


class FakeBuffer(object):
    def __init__(self, reader):
        self.reader = reader

    def getReader(self):
        return self.reader


class FakeSource(object):
    """Minimal SDR source with the interface used by the IQ classes."""
    def __init__(self, samp_rate=4, center_freq=145000000, state=None):
        self.props = PropertyLayer(samp_rate=samp_rate, center_freq=center_freq)
        self.reader = FakeReader()
        self.clients = []
        self.state = state

    def isAvailable(self):
        return True

    def getId(self):
        return "fake"

    def getProps(self):
        return self.props

    def getBuffer(self):
        return FakeBuffer(self.reader)

    def addClient(self, c):
        self.clients.append(c)
        if self.state is not None:
            c.onStateChange(self.state)

    def removeClient(self, c):
        if c in self.clients:
            self.clients.remove(c)

    def getName(self):
        return "Fake SDR"

    def getProfileName(self):
        return "Test"
