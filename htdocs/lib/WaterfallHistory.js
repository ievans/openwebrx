//
// Waterfall History
//
// Keeps a ring buffer of received FFT lines, decoupled from what the
// waterfall displays: the waterfall (and spectrum) always keep showing
// live data, scrolling continuously. A "playhead" line marks where in
// that scrolling waterfall the current replay position is, while audio
// follows the replay position instead of live data. Lines are stored as
// 16bit integers (0.01dB resolution) to save memory.
//

function WaterfallHistory() {
    this.frames   = [];     // { t, cf, bw, d: Int16Array }
    this.bytes    = 0;
    this.maxBytes = 64 * 1024 * 1024;
    this.maxAge   = 10 * 60 * 1000;
    this.live     = true;
    this.cursor   = -1;     // index of the frame the playhead is on
    this.speed    = 0;      // playback speed, negative for reverse
    this.timer    = 0;
    this.lastTick = 0;
    this.playT    = 0;      // playback clock, in msec timestamps
    this.audioT   = null;   // playback clock position of last replayed audio
    // Server side IQ replay: 'off', 'pending', 'active' or 'failed' (when the
    // server can not replay, only locally remembered audio is played)
    this.serverReplay = 'off';
    this.replayId     = 0;
    this.replayError  = null;
    this.replayTimer  = 0;
    // TRUE when locally remembered audio exists, but for another frequency
    this.localMismatch = false;
    this.lastUi   = 0;
    // Rows down from the top of the waterfall where the IQ buffer line is
    // drawn, or -1 when not shown
    this.bufferRows = -1;
}

// Lines arrive with network jitter, so their arrival times are off by up
// to this much. Markers are kept on their waterfall row and only re-placed
// from timestamps once they are off by more than this.
WaterfallHistory.JITTER_MS = 1000;

// The server keeps dropping its oldest IQ data, so playback started right
// at the edge of its buffer would fail. Stay this far inside it.
WaterfallHistory.EDGE_MARGIN_MS = 2000;

WaterfallHistory.prototype.isLive = function() {
    return this.live;
};

WaterfallHistory.prototype.clear = function() {
    this.frames = [];
    this.bytes  = 0;
    if (!this.live) this.goLive();
};

// Store a new live FFT line. The waterfall and spectrum always display it
// live; this only keeps history for the playhead, audio replay and the
// IQ buffer marker.
WaterfallHistory.prototype.push = function(data) {
    var d = new Int16Array(data.length);
    for (var j = 0; j < data.length; ++j) {
        d[j] = Math.max(-32768, Math.min(32767, Math.round(data[j] * 100)));
    }
    this.frames.push({ t: Date.now(), cf: center_freq, bw: bandwidth, d: d });
    this.bytes += d.byteLength;
    // The waterfall just scrolled down one row, and at 1x the playhead
    // moves forward by one line in the same time, so it stays on the same
    // screen row. Looking the line up by arrival time instead makes the
    // playhead jitter up and down with the network.
    if (!this.live && this.speed == 1) {
        this.cursor = Math.min(this.cursor + 1, this.frames.length - 1);
    }
    this.evict();

    this.updateBufferMarker();
    this.updatePlayheadMarker();

    // The rest of the UI only needs to refresh occasionally
    if (Date.now() - this.lastUi > (this.live? 1000 : 250)) this.updateUi();
};

WaterfallHistory.prototype.evict = function() {
    var now = Date.now();
    var n = 0;
    while (n < this.frames.length - 1 && (
        this.bytes > this.maxBytes || now - this.frames[n].t > this.maxAge
    )) {
        this.bytes -= this.frames[n].d.byteLength;
        ++n;
    }
    if (n > 0) {
        this.frames.splice(0, n);
        if (this.cursor >= 0) this.cursor = Math.max(0, this.cursor - n);
    }
};

// Decode a stored frame into dB values matching the CURRENT display,
// remapping it if it was captured at a different center frequency.
WaterfallHistory.prototype.frameData = function(i) {
    var f = this.frames[i];
    var len = f.d.length;
    var out = new Float32Array(fft_size);
    var j;

    if (f.cf == center_freq && f.bw == bandwidth && len == fft_size) {
        for (j = 0; j < len; ++j) out[j] = f.d[j] / 100;
    } else {
        for (j = 0; j < fft_size; ++j) {
            var freq = center_freq + (j / fft_size - 0.5) * bandwidth;
            var k = Math.round(((freq - f.cf) / f.bw + 0.5) * len);
            out[j] = k >= 0 && k < len? f.d[k] / 100 : -200;
        }
    }

    return out;
};

// Stop tracking live audio; the playhead starts out at the newest frame.
WaterfallHistory.prototype.freeze = function() {
    if (this.live && this.frames.length) {
        this.live   = false;
        this.cursor = this.frames.length - 1;
        // Live audio does not match the replay position, silence it
        this.updateAudio();
    }
    return !this.live;
};

WaterfallHistory.prototype.pause = function() {
    if (this.freeze()) this.setSpeed(0);
};

// Play/pause button: pauses when live or moving, plays at 1x when paused.
// It never returns to live, that is what the LIVE button is for.
WaterfallHistory.prototype.togglePlay = function() {
    if (this.live || this.speed != 0) this.pause(); else this.setSpeed(1);
};

WaterfallHistory.prototype.goLive = function() {
    this.setSpeed(0);
    this.live   = true;
    this.cursor = -1;
    this.syncAudio();
    this.updateUi();
};

// Seek by a number of seconds relative to the current position. If the
// waterfall was moving (live, or already playing back), it keeps moving
// afterwards, at the same speed, rather than leaving it stuck at the new
// position.
WaterfallHistory.prototype.skip = function(seconds) {
    var wasMoving = this.live || this.speed != 0;
    var speed = this.speed || 1;
    if (!this.freeze()) return;
    var t = this.frames[this.cursor].t + seconds * 1000;
    this.cursor = Math.max(this.indexAt(t), this.oldestPlayable());
    this.playT  = this.frames[this.cursor].t;
    this.audioT = null;
    if (this.cursor >= this.frames.length - 1 && seconds > 0) {
        this.goLive();
    } else if (wasMoving) {
        this.setSpeed(speed);
    } else {
        this.syncAudio(true);
        this.updateUi();
    }
};

// Click anywhere on the (always live) waterfall to move the playhead
// straight to that moment in time and start playing right away, instead
// of having to pause and skip back. relativeY is measured in pixels down
// from the top of the waterfall, where 0 is "now" and each row further
// down is one frame further into the past. Clicks further back than audio
// can be replayed snap to the oldest point that still can. Returns FALSE
// if there is no history yet.
WaterfallHistory.prototype.clickSeek = function(relativeY) {
    // A click right at the top is just tuning, not a time jump
    if (relativeY < 5) return true;
    if (this.frames.length < 2) return false;
    if (!this.freeze()) return false;
    this.cursor = Math.max(0, this.frames.length - 1 - Math.round(relativeY));
    // Snaps to the oldest playable point if that is too far back
    this.setSpeed(1);
    return true;
};

// Index of the oldest frame that playback may start from: the IQ buffer
// line when the server replays audio, else the oldest frame.
WaterfallHistory.prototype.oldestPlayable = function() {
    if (!this.canReplayOnServer()) return 0;
    var rows = this.updateBufferRows();
    if (rows >= 0) return this.frames.length - 1 - rows;
    // The server's buffer reaches back further than the waterfall history,
    // but may have started at the same time, so keep off its edge anyway
    return this.firstIndexFrom(this.frames[0].t + WaterfallHistory.EDGE_MARGIN_MS);
};

// Move the playhead to time T, with a few seconds after T so that
// whatever started at T is not immediately behind it. Returns FALSE if T
// is no longer in the history.
WaterfallHistory.prototype.seekTime = function(t, after = 3) {
    if (!this.frames.length || t < this.frames[0].t) return false;
    if (!this.freeze()) return false;
    this.setSpeed(0);
    this.cursor = this.indexAt(t + after * 1000);
    this.playT  = this.frames[this.cursor].t;
    this.audioT = null;
    this.updateUi();
    return true;
};

// Find the newest frame not newer than time T.
WaterfallHistory.prototype.indexAt = function(t) {
    var lo = 0, hi = this.frames.length - 1;
    while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (this.frames[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
};

// Find the oldest frame not older than time T (the newest frame if none).
WaterfallHistory.prototype.firstIndexFrom = function(t) {
    var i = this.indexAt(t);
    if (this.frames[i].t < t) ++i;
    return Math.min(i, this.frames.length - 1);
};

// Play back at given speed (1 = realtime, -1 = realtime reverse, 0 = stop).
WaterfallHistory.prototype.setSpeed = function(speed) {
    if (speed != 0 && !this.freeze()) return;
    // Never start playing where there is no audio to replay anymore, e.g.
    // after a click below the IQ buffer line or a long pause
    if (speed == 1) this.cursor = Math.max(this.cursor, this.oldestPlayable());
    this.speed = speed;
    if (this.timer) {
        clearInterval(this.timer);
        this.timer = 0;
    }
    if (speed != 0) {
        var me = this;
        this.lastTick = Date.now();
        this.playT    = this.frames[this.cursor].t;
        this.audioT   = null;
        this.timer = setInterval(function() { me.tick(); }, 40);
    }
    this.syncAudio(true);
    this.updateUi();
};

// Server side IQ replay lets the user tune anywhere while listening to
// the past. It needs the server's IQ time-shift buffer to be enabled.
WaterfallHistory.prototype.canReplayOnServer = function() {
    return typeof iq_buffer_seconds !== 'undefined' && iq_buffer_seconds > 0;
};

// Pick the audio source for the current state: live audio when live,
// server IQ replay (or else locally remembered audio) when playing back
// at normal speed, and silence otherwise. RESTART requests server replay
// from the current position again, e.g. after seeking.
WaterfallHistory.prototype.syncAudio = function(restart = false) {
    var want = !this.live && this.speed == 1 && this.canReplayOnServer();
    if (want && (restart || this.serverReplay === 'off')) {
        this.requestServerReplay();
    } else if (!want && this.serverReplay !== 'off') {
        this.stopServerReplay();
    }
    this.updateAudio();
};

WaterfallHistory.prototype.requestServerReplay = function() {
    var me = this;
    var id = ++this.replayId;
    this.serverReplay = 'pending';
    this.replayError = null;
    // Seeking repeatedly (e.g. clicking -10s a few times) moves a lot,
    // only ask once it settles
    clearTimeout(this.replayTimer);
    this.replayTimer = setTimeout(function() {
        if (me.replayId !== id) return;
        ws.send(JSON.stringify({
            type: 'replay',
            params: { action: 'start', id: id, age_ms: Math.max(0, Date.now() - me.playT) }
        }));
    }, 150);
};

WaterfallHistory.prototype.stopServerReplay = function() {
    clearTimeout(this.replayTimer);
    ++this.replayId;
    this.serverReplay = 'off';
    ws.send(JSON.stringify({ type: 'replay', params: { action: 'stop' } }));
};

// Handle server's answer to a replay request, or replay ending by itself.
WaterfallHistory.prototype.onReplayStatus = function(status) {
    if (status.id !== this.replayId || this.serverReplay === 'off') return;
    if (status.active) {
        this.serverReplay = 'active';
    } else {
        // Continue with locally remembered audio of the tuned frequency
        this.serverReplay = 'failed';
        this.replayError = status.error;
    }
    this.updateAudio();
    this.updateUi();
};

WaterfallHistory.prototype.updateAudio = function() {
    var server = this.serverReplay === 'active' && !this.live && this.speed == 1;
    // Server replay comes in as a normal audio stream, so play it,
    // but do not remember it as live audio
    audioEngine.setPaused(!this.live && !server);
    audioEngine.setHistoryEnabled(!server);
};

WaterfallHistory.prototype.tick = function() {
    if (this.live || !this.frames.length) return;
    var now = Date.now();
    this.playT += (now - this.lastTick) * this.speed;
    this.lastTick = now;
    var t = this.playT;

    if (this.speed > 0) {
        // Caught up with live data: switch back to live
        if (t >= this.frames[this.frames.length - 1].t) {
            this.goLive();
            return;
        }
        // Replay locally remembered audio at normal speed, unless the
        // server replays (or is about to replay) the whole spectrum
        if (this.speed == 1) {
            var local = this.serverReplay === 'off' || this.serverReplay === 'failed';
            if (local && this.audioT !== null) {
                var r = audioEngine.replay(this.audioT, t);
                if (r.played || r.skipped) this.localMismatch = !r.played;
            }
            this.audioT = t;
            // push() keeps the playhead on its row; only re-place it if
            // it has drifted from the audio position beyond network jitter
            if (Math.abs(this.frames[this.cursor].t - t) > WaterfallHistory.JITTER_MS) {
                this.cursor = this.indexAt(t);
            }
        } else {
            this.cursor = this.indexAt(t);
        }
    } else {
        var prev = this.indexAt(t);
        if (prev <= 0) {
            this.cursor = 0;
            this.setSpeed(0);
        } else {
            this.cursor = prev;
        }
    }

    // Move the playhead every tick, not just when the rest of the UI
    // refreshes, or it visibly lags behind and then jumps to catch up
    this.updatePlayheadMarker();

    if (now - this.lastUi > 250) this.updateUi();
};

// The IQ buffer line marks how far back one can click/rewind and still
// hear server replayed audio: the oldest frame a little inside the edge of
// the server's buffer. Like the playhead, it stays on its screen row as
// the waterfall scrolls, and is only re-placed once line arrival jitter
// can not explain the difference. Returns its row, or -1 while the buffer
// reaches back beyond the history.
WaterfallHistory.prototype.updateBufferRows = function() {
    var n = this.frames.length;
    if (!this.canReplayOnServer() || n < 2) return this.bufferRows = -1;
    var edgeT = this.frames[n - 1].t - iq_buffer_seconds * 1000;
    if (edgeT < this.frames[0].t) return this.bufferRows = -1;
    var limitT = edgeT + WaterfallHistory.EDGE_MARGIN_MS;
    var rows = this.bufferRows;
    if (rows >= 0 && rows < n && Math.abs(this.frames[n - 1 - rows].t - limitT) <= WaterfallHistory.JITTER_MS) {
        return rows;
    }
    return this.bufferRows = (n - 1) - this.firstIndexFrom(limitT);
};

WaterfallHistory.prototype.updateBufferMarker = function() {
    var $marker = $('#openwebrx-iq-buffer-marker');
    var rows = this.updateBufferRows();
    if (rows <= 0 || typeof canvas_container === 'undefined' || !canvas_container ||
        rows >= canvas_container.clientHeight) {
        $marker.hide();
        return;
    }

    var n = this.frames.length;
    var seconds = Math.round((this.frames[n - 1].t - this.frames[n - 1 - rows].t) / 1000);
    $marker.find('span').text('buffer at ' + seconds + 's');
    $marker.css('top', rows + 'px').show();
};

// Mark on the (always live) waterfall exactly where the playhead (the
// current replay position) is, so it is clear at a glance "you are here",
// without moving or redrawing the waterfall itself.
WaterfallHistory.prototype.updatePlayheadMarker = function() {
    var $marker = $('#openwebrx-replay-position-marker');
    if (this.live || this.frames.length < 2 ||
        typeof canvas_container === 'undefined' || !canvas_container) {
        $marker.hide();
        return;
    }

    var offset = (this.frames.length - 1) - this.cursor;
    var height = canvas_container.clientHeight;

    if (offset < 0 || offset >= height) {
        $marker.hide();
    } else {
        var seconds = Math.round((this.frames[this.frames.length - 1].t - this.frames[this.cursor].t) / 1000);
        $marker.find('span').text('playhead at ' + seconds + 's');
        $marker.css('top', offset + 'px').show();
    }
};

// The playhead and IQ buffer markers already show the replay position and
// how far back audio is available, so the banner is just a plain prompt
// back to live, shown whenever not live.
WaterfallHistory.prototype.updateUi = function() {
    this.lastUi = Date.now();

    this.updateBufferMarker();
    this.updatePlayheadMarker();

    if (this.live) {
        $('#openwebrx-history-overlay').hide();
    } else {
        $('#openwebrx-history-overlay').show();
    }
};
