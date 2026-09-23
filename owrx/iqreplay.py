from pycsdr.modules import Buffer
from pycsdr.types import Format

import threading
import time

import logging

logger = logging.getLogger(__name__)


class ReplayUnavailable(Exception):
    pass


#
# Replays IQ data from an IqTimeShiftBuffer into one client's demodulator
# chain, as if it was coming from the SDR right now, but some time ago.
# Since the demodulator works on the whole recorded spectrum, the client
# can tune anywhere and change modes while listening to the past.
#
# Chunks are written at the same pace they originally arrived at, shifted
# by a constant delay, so the chain sees a normal real time stream.
#
class IqReplay(object):
    # Give up if no new data arrives for this long
    STALL_TIMEOUT = 5.0

    def __init__(self, timeShiftBuffer, dsp, sdrSource, onStop=None):
        self.timeShiftBuffer = timeShiftBuffer
        self.dsp = dsp
        self.sdrSource = sdrSource
        self.onStop = onStop
        self.buffer = None
        self.thread = None
        self.running = False
        self.error = None

    def start(self, age: float):
        seq = self.timeShiftBuffer.findChunk(age)
        if seq is None:
            raise ReplayUnavailable("No IQ data buffered from {0:.0f} seconds ago".format(age))
        try:
            chunk = self.timeShiftBuffer.getChunk(seq)
        except LookupError:
            chunk = None
        if chunk is None:
            raise ReplayUnavailable("No IQ data buffered from {0:.0f} seconds ago".format(age))
        if chunk[1] != self.sdrSource.getProps()["center_freq"]:
            raise ReplayUnavailable("IQ data from that time is from a different frequency band")

        # Chunk N gets written at its original arrival time plus this delay
        delay = time.monotonic() - chunk[3]
        self.buffer = Buffer(Format.COMPLEX_FLOAT)
        self.running = True
        self.dsp.setInputReader(self.buffer.getReader())
        self.thread = threading.Thread(target=self._run, args=(seq, delay), name="iq-replay")
        self.thread.start()
        logger.debug("Started IQ replay from %.1f seconds ago", age)

    def stop(self, error: str = None):
        if not self.running:
            return
        self.running = False
        if error is not None:
            self.error = error
        if self.thread is not None and self.thread is not threading.current_thread():
            self.thread.join(2)
        self.dsp.setInputReader(None)

    def _run(self, seq: int, delay: float):
        waitingSince = None
        try:
            while self.running:
                try:
                    chunk = self.timeShiftBuffer.getChunk(seq)
                except LookupError:
                    self.error = "IQ data no longer buffered"
                    break
                now = time.monotonic()
                if chunk is None:
                    # Nothing buffered yet (e.g. buffer was just cleared)
                    waitingSince = waitingSince or now
                    if now - waitingSince > IqReplay.STALL_TIMEOUT:
                        self.error = "IQ data stopped arriving"
                        break
                    time.sleep(0.05)
                    continue
                waitingSince = None
                due = chunk[3] + delay
                if due > now:
                    # Sleep in short steps so that stop() is quick
                    time.sleep(min(due - now, 0.05))
                    continue
                if chunk[1] != self.sdrSource.getProps()["center_freq"]:
                    self.error = "Center frequency changed"
                    break
                self.buffer.write(chunk[2])
                seq += 1
        except Exception as e:
            logger.exception("Exception during IQ replay")
            self.error = str(e)
        finally:
            if self.running:
                # Stopped on our own: return to live input and report
                self.running = False
                self.dsp.setInputReader(None)
                if self.onStop is not None:
                    try:
                        self.onStop(self.error)
                    except Exception:
                        logger.exception("Exception reporting IQ replay stop")
