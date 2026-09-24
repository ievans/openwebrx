import io
import socket
from unittest import TestCase

from owrx.websocket import WebSocketConnection, Handler


class FakeRequestHandler(object):
    def __init__(self, wfile):
        self.headers = {"Upgrade": "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ=="}
        self.wfile = wfile
        self.rfile = io.BytesIO(b"")

        class Connection(object):
            def setblocking(self, flag):
                pass

        self.connection = Connection()


class RecordingHandler(Handler):
    def __init__(self):
        self.closed = 0

    def handleTextMessage(self, connection, message):
        pass

    def handleBinaryMessage(self, connection, data):
        pass

    def handleClose(self):
        self.closed += 1


class WebSocketSendAfterErrorTest(TestCase):
    def setUp(self):
        self.local, self.remote = socket.socketpair()
        self.wfile = self.local.makefile("wb", buffering=0)
        self.handler = RecordingHandler()
        self.conn = WebSocketConnection(FakeRequestHandler(self.wfile), self.handler)
        self.conn.cancelPing()

    def tearDown(self):
        self.conn.cancelPing()
        for f in (self.wfile, self.local, self.remote):
            try:
                f.close()
            except OSError:
                pass

    def breakSocket(self):
        self.remote.close()
        self.local.close()

    def testWarnsOnceForSendsAfterSocketError(self):
        self.breakSocket()
        with self.assertLogs("owrx.websocket", level="WARNING") as logs:
            for i in range(5):
                self.conn.send("frame %d" % i)
        ignored = [r for r in logs.records if "after socket error" in r.getMessage()]
        self.assertEqual(len(ignored), 1)
        self.assertTrue(self.conn.socketError)
        self.assertFalse(self.conn.open)

    def testWriteErrorLeavesTeardownToReadLoop(self):
        # tearing the handler down on the sending thread can deadlock on locks
        # that thread already holds; the read loop does it once it wakes up
        self.breakSocket()
        with self.assertLogs("owrx.websocket", level="ERROR"):
            self.conn.send("frame")
        self.assertEqual(self.handler.closed, 0)
