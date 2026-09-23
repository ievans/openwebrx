//
// Waterfall History
//
// Keeps a ring buffer of received FFT lines so that the waterfall can be
// paused, rewound, scrubbed and played back at different speeds, while
// live data keeps being recorded in the background. Lines are stored as
// 16bit integers (0.01dB resolution) to save memory.
//

function WaterfallHistory() {
    this.frames   = [];     // { t, cf, bw, d: Int16Array }
    this.bytes    = 0;
    this.maxBytes = 64 * 1024 * 1024;
    this.maxAge   = 10 * 60 * 1000;
    this.live     = true;
    this.cursor   = -1;     // index of the newest displayed frame
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
    this.pending  = false;
    this.lastUi   = 0;
}

WaterfallHistory.prototype.isLive = function() {
    return this.live;
};

WaterfallHistory.prototype.clear = function() {
    this.frames = [];
    this.bytes  = 0;
    if (!this.live) this.goLive();
};

// Store a new live FFT line. Returns TRUE if it should be shown live.
WaterfallHistory.prototype.push = function(data) {
    var d = new Int16Array(data.length);
    for (var j = 0; j < data.length; ++j) {
        d[j] = Math.max(-32768, Math.min(32767, Math.round(data[j] * 100)));
    }
    this.frames.push({ t: Date.now(), cf: center_freq, bw: bandwidth, d: d });
    this.bytes += d.byteLength;
    this.evict();

    // Keep timeline position and labels current, but not too often
    if (Date.now() - this.lastUi > (this.live? 1000 : 250)) this.updateUi();

    return this.live;
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

// Rebuild the whole waterfall image so that frame #end is the top line.
WaterfallHistory.prototype.redraw = function(end) {
    if (!this.frames.length || !waterfall_setup_done) return;
    end = Math.max(0, Math.min(this.frames.length - 1, end));
    var lines = Math.max(200, canvas_container? canvas_container.parentNode.clientHeight : 600);
    var start = Math.max(0, end - lines + 1);

    waterfall_clear();
    for (var i = start; i <= end; ++i) waterfall_add(this.frameData(i));
    spectrum.update(this.frameData(end));
};

// Throttle expensive full redraws to the display refresh rate.
WaterfallHistory.prototype.requestRedraw = function() {
    if (this.pending) return;
    this.pending = true;
    var me = this;
    requestAnimationFrame(function() {
        me.pending = false;
        if (!me.live) me.redraw(me.cursor);
    });
};

// Freeze the display at the newest frame, if currently live.
WaterfallHistory.prototype.freeze = function() {
    if (this.live && this.frames.length) {
        this.live   = false;
        this.cursor = this.frames.length - 1;
        // Live audio does not match the replayed waterfall, silence it
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
    this.redraw(this.frames.length - 1);
    this.updateUi();
};

// Seek by a number of seconds relative to the current position.
WaterfallHistory.prototype.skip = function(seconds) {
    if (!this.freeze()) return;
    var t = this.frames[this.cursor].t + seconds * 1000;
    this.cursor = this.indexAt(t);
    this.playT  = this.frames[this.cursor].t;
    this.audioT = null;
    if (this.cursor >= this.frames.length - 1 && seconds > 0) {
        this.goLive();
    } else {
        this.syncAudio(true);
        this.requestRedraw();
        this.updateUi();
    }
};

// Show the waterfall as it was at time T, with a few seconds after T
// on top so that whatever started at T is visible. Returns FALSE if T
// is no longer in the history.
WaterfallHistory.prototype.seekTime = function(t, after = 3) {
    if (!this.frames.length || t < this.frames[0].t) return false;
    if (!this.freeze()) return false;
    this.setSpeed(0);
    this.cursor = this.indexAt(t + after * 1000);
    this.playT  = this.frames[this.cursor].t;
    this.audioT = null;
    this.requestRedraw();
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

// Play back at given speed (1 = realtime, -1 = realtime reverse, 0 = stop).
WaterfallHistory.prototype.setSpeed = function(speed) {
    if (speed != 0 && !this.freeze()) return;
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
        // Caught up with live data: switch back to live display
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
        }
        // Moving forward: just append new lines to the waterfall
        var next = this.indexAt(t);
        while (this.cursor < next) {
            waterfall_add(this.frameData(++this.cursor));
        }
        spectrum.update(this.frameData(this.cursor));
    } else {
        // Moving backward: have to redraw the whole waterfall
        var prev = this.indexAt(t);
        if (prev <= 0) {
            this.cursor = 0;
            this.setSpeed(0);
        } else {
            this.cursor = prev;
        }
        this.requestRedraw();
    }

    if (now - this.lastUi > 250) this.updateUi();
};

WaterfallHistory.prototype.getDuration = function() {
    if (this.frames.length < 2) return 0;
    return (this.frames[this.frames.length - 1].t - this.frames[0].t) / 1000;
};

WaterfallHistory.prototype.formatDelta = function(sec) {
    sec = Math.round(sec);
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return '-' + m + ':' + ('' + s).padStart(2, '0');
};

WaterfallHistory.prototype.updateUi = function() {
    this.lastUi = Date.now();

    var $overlay = $('#openwebrx-history-overlay');
    var $label   = $('#openwebrx-history-label');
    var $button  = $('.openwebrx-history-button');
    var n = this.frames.length;

    // Play/pause shows what pressing it does, and is lit while paused.
    // LIVE is lit while showing live data.
    var moving = this.live || this.speed != 0;
    $button.html(moving? '&#10074;&#10074;' : '&#9654;');
    $button.attr('title', moving? 'Pause waterfall and audio' : 'Play at normal speed');
    $button.toggleClass('highlighted', !moving);
    $('.openwebrx-live-button').toggleClass('highlighted', this.live);
    var speed = this.speed;
    $('.openwebrx-history-speed').each(function() {
        $(this).toggleClass('highlighted', !!speed && Number(this.dataset.speed) == speed);
    });

    if (this.live || !n) {
        $overlay.hide();
        $label.text('LIVE ' + this.formatDelta(this.getDuration()).substring(1));
        return;
    }

    var f = this.frames[this.cursor];
    var delta = (this.frames[n - 1].t - f.t) / 1000;
    var text = this.formatDelta(delta) + ' (' + Utils.HHMMSS(f.t) + ' UTC)';
    if (this.speed != 0) text += ' ' + (this.speed > 0? '▶' : '◀') + Math.abs(this.speed) + 'x';

    $label.text(text);
    // Explain why the server does not replay the whole spectrum
    var reason = !this.canReplayOnServer()? 'IQ time-shift buffer is off on the server'
        : this.replayError || '';
    var audio = this.speed != 1? 'audio paused'
        : this.serverReplay === 'active'? 'replaying audio, tune anywhere'
        : this.serverReplay === 'pending'? 'loading audio'
        : (this.localMismatch? 'no recorded audio at this frequency'
            : 'replaying audio of tuned frequency only') + (reason? ' (' + reason + ')' : '');
    $overlay.find('.openwebrx-history-overlay-text').text('REPLAY ' + text + ' \u00b7 ' + audio);
    $overlay.show();
};
