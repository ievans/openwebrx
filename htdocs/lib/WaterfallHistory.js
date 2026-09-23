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
    this.pending  = false;
    this.lastUi   = 0;

    try {
        var m = parseInt(localStorage.getItem('wf_history_minutes'));
        if (m > 0) this.maxAge = m * 60 * 1000;
    } catch (e) {}
}

WaterfallHistory.prototype.isLive = function() {
    return this.live;
};

WaterfallHistory.prototype.setMaxMinutes = function(minutes) {
    this.maxAge = Math.max(1, Number(minutes)) * 60 * 1000;
    audioEngine.setHistoryMaxAge(this.maxAge);
    try { localStorage.setItem('wf_history_minutes', '' + minutes); } catch (e) {}
    this.evict();
    this.updateUi();
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
        audioEngine.setPaused(true);
    }
    return !this.live;
};

WaterfallHistory.prototype.pause = function() {
    if (this.freeze()) this.setSpeed(0);
};

WaterfallHistory.prototype.goLive = function() {
    this.setSpeed(0);
    this.live   = true;
    this.cursor = -1;
    audioEngine.setPaused(false);
    this.redraw(this.frames.length - 1);
    this.updateUi();
};

// Seek to a relative position in the buffer (0 = oldest, 1 = newest).
WaterfallHistory.prototype.seek = function(pos) {
    if (!this.freeze()) return;
    this.cursor = Math.round(Math.max(0, Math.min(1, pos)) * (this.frames.length - 1));
    this.playT  = this.frames[this.cursor].t;
    this.audioT = null;
    this.requestRedraw();
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
    this.updateUi();
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
        // Replay recorded audio, but only at normal speed
        if (this.speed == 1) {
            if (this.audioT !== null) audioEngine.replay(this.audioT, t);
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
    var $slider  = $('#openwebrx-history-slider');
    var $label   = $('#openwebrx-history-label');
    var $button  = $('.openwebrx-history-button');
    var n = this.frames.length;

    // Pause is lit while stopped in history, LIVE while showing live data
    $button.toggleClass('highlighted', !this.live && !this.speed);
    $('.openwebrx-live-button').toggleClass('highlighted', this.live);
    var speed = this.speed;
    $('.openwebrx-history-speed').each(function() {
        $(this).toggleClass('highlighted', !!speed && Number(this.dataset.speed) == speed);
    });

    if (this.live || !n) {
        $overlay.hide();
        $slider.val(1000);
        $label.text('LIVE ' + this.formatDelta(this.getDuration()).substring(1));
        return;
    }

    var f = this.frames[this.cursor];
    var delta = (this.frames[n - 1].t - f.t) / 1000;
    var text = this.formatDelta(delta) + ' (' + Utils.HHMMSS(f.t) + ' UTC)';
    if (this.speed != 0) text += ' ' + (this.speed > 0? '▶' : '◀') + Math.abs(this.speed) + 'x';

    // Do not fight the user dragging the slider
    if (!$slider.is(':active')) {
        $slider.val(n > 1? Math.round(1000 * this.cursor / (n - 1)) : 1000);
    }
    $label.text(text);
    var audio = this.speed == 1? 'replaying audio' : 'audio paused';
    $overlay.find('.openwebrx-history-overlay-text').text('REPLAY ' + text + ' \u00b7 ' + audio);
    $overlay.show();
};
