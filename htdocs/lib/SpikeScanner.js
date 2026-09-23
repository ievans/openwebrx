//
// Spike Scanner
//
// Watches the incoming FFT data and automatically tunes to the strongest
// NEW signal that rises above the noise floor. Each FFT bin keeps a slow
// moving baseline, so constant carriers and birdies are absorbed into the
// baseline and ignored, while freshly appearing signals stand out. Short
// impulses are rejected by requiring a signal to persist for several frames.
//

function SpikeScanner() {
    this.running   = false;
    this.snr       = 12;    // dB above noise floor to count as a signal
    this.novelty   = 8;     // dB above per-bin baseline to count as "new"
    this.persist   = 3;     // consecutive frames a spike must be present
    this.hang      = 2000;  // msec to stay on a signal after it disappears
    this.minDwell  = 1500;  // msec to stay on a signal before preempting it
    this.preempt   = 6;     // dB a new spike must beat current one by
    this.warmup    = 20;    // frames used to learn the baseline after reset
    this.edge      = 0.05;  // fraction of spectrum ignored on each edge
    this.maxWidth  = 0.20;  // spikes wider than this fraction are ignored
    this.lockouts  = [];    // absolute frequencies to ignore, as [low, high]
    this.autoTune  = true;  // FALSE to only log activity without tuning
    this.log       = [];    // activity log, newest first
    this.maxLog    = 500;   // maximum number of log entries
    this.active    = [];    // log entries for signals still on the air
    this.onLog     = null;  // called when the activity log changes
    this.reset();
}

SpikeScanner.prototype.reset = function() {
    this.closeActive();
    this.baseline = null;
    this.hits     = null;
    this.frames   = 0;
    this.current  = null;
    this.cf       = center_freq;
    this.bw       = bandwidth;
};

SpikeScanner.prototype.isRunning = function() {
    return this.running;
};

SpikeScanner.prototype.start = function() {
    if (!this.running) {
        this.reset();
        this.running = true;
    }
    return this.running;
};

SpikeScanner.prototype.stop = function() {
    this.running = false;
    this.current = null;
    this.closeActive();
    return !this.running;
};

SpikeScanner.prototype.setAutoTune = function(on) {
    this.autoTune = !!on;
    if (!on) this.current = null;
};

SpikeScanner.prototype.clearLog = function() {
    this.log = [];
    this.active = [];
    if (this.onLog) this.onLog();
};

// Mark all signals still on the air as finished.
SpikeScanner.prototype.closeActive = function() {
    if (!this.active || !this.active.length) return;
    this.active.forEach(function(e) { e.active = false; });
    this.active = [];
    if (this.onLog) this.onLog();
};

// Export activity log as CSV text, oldest entries first.
SpikeScanner.prototype.getLogCsv = function() {
    var iso = function(t) { return new Date(t).toISOString(); };
    var rows = ['start_utc,end_utc,frequency_hz,peak_db_above_floor,duration_s,width_hz'];
    for (var j = this.log.length - 1; j >= 0; --j) {
        var e = this.log[j];
        rows.push([
            iso(e.start), iso(e.last), Math.round(e.freq), e.peak.toFixed(1),
            ((e.last - e.start) / 1000).toFixed(1), Math.round(e.width * e.binHz)
        ].join(','));
    }
    return rows.join('\n') + '\n';
};

// Get maximum level around given frequency, relative to noise floor.
SpikeScanner.prototype.levelAt = function(data, freq, width, floor) {
    var len = data.length;
    var c = Math.round(((freq - this.cf) / this.bw + 0.5) * len);
    var w = Math.max(1, Math.ceil(width / 2));
    var peak = -1000;
    for (var j = Math.max(0, c - w); j <= Math.min(len - 1, c + w); ++j) peak = Math.max(peak, data[j]);
    return peak - floor;
};

// Record detected spikes into the activity log, merging each spike with
// a matching signal that is still on the air.
SpikeScanner.prototype.track = function(spikes, data, floor, now) {
    var binHz = this.bw / data.length;
    var changed = false;
    var me = this;

    spikes.forEach(function(s) {
        var e = me.active.find(function(e) {
            return Math.abs(e.freq - s.freq) <= Math.max(e.width, s.width, 2) * binHz;
        });
        if (e) {
            e.last = now;
            if (s.score > e.peak) {
                e.peak = s.score;
                e.freq = s.freq;
                e.width = Math.max(e.width, s.width);
            }
        } else {
            e = {
                start: now, last: now, freq: s.freq, peak: s.score,
                width: s.width, binHz: binHz, active: true
            };
            me.active.push(e);
            me.log.unshift(e);
            if (me.log.length > me.maxLog) me.log.length = me.maxLog;
        }
        changed = true;
    });

    // Signals fade into the baseline over time, so keep them alive for
    // as long as they stay above the noise floor
    this.active = this.active.filter(function(e) {
        if (e.last < now && me.levelAt(data, e.freq, e.width, floor) >= me.snr - 3) e.last = now;
        if (now - e.last <= me.hang) return true;
        e.active = false;
        changed = true;
        return false;
    });

    if (changed && this.onLog) this.onLog();
};

SpikeScanner.prototype.setSnr = function(snr) {
    this.snr = Number(snr);
};

// Ignore the signal we are currently parked on, and move on.
SpikeScanner.prototype.lockoutCurrent = function() {
    if (!this.current) return false;
    var halfBin = this.current.width * this.bw / this.baseline.length / 2;
    var f = this.current.freq;
    this.lockouts.push([f - halfBin, f + halfBin]);
    this.current = null;
    return true;
};

SpikeScanner.prototype.clearLockouts = function() {
    this.lockouts = [];
};

// Estimate the noise floor as a low percentile of a subsample of bins.
SpikeScanner.prototype.noiseFloor = function(data, start, end) {
    var step = Math.max(1, Math.floor((end - start) / 512));
    var s = [];
    for (var j = start; j < end; j += step) s.push(data[j]);
    s.sort(function(a, b) { return a - b; });
    return s[Math.floor(s.length * 0.3)];
};

SpikeScanner.prototype.binToFreq = function(bin, len) {
    return this.cf + (bin / len - 0.5) * this.bw;
};

SpikeScanner.prototype.isLockedOut = function(f) {
    return this.lockouts.some(function(l) { return f >= l[0] && f <= l[1]; });
};

SpikeScanner.prototype.update = function(data) {
    if (!this.running) return;

    var len = data.length;
    var j;

    // Relearn everything if the spectrum has moved or changed shape
    if (!this.baseline || this.baseline.length != len || this.cf != center_freq || this.bw != bandwidth) {
        this.reset();
        this.baseline = Float32Array.from(data);
        this.hits = new Uint8Array(len);
    }

    // Only scan the visible part of the waterfall, minus filter edges
    var range = get_visible_freq_range();
    var start = Math.max(Math.round(len * this.edge), Math.floor(((range.start - this.cf) / this.bw + 0.5) * len));
    var end   = Math.min(Math.round(len * (1 - this.edge)), Math.ceil(((range.end - this.cf) / this.bw + 0.5) * len));
    if (end - start < 8) return;

    var floor = this.noiseFloor(data, start, end);

    // Mark bins that are both above the noise floor and above their baseline
    for (j = 0; j < len; ++j) {
        var hit = (data[j] - floor >= this.snr) && (data[j] - this.baseline[j] >= this.novelty);
        this.hits[j] = hit? Math.min(this.hits[j] + 1, 255) : 0;
        // Slowly learn persistent signals into the baseline, forget faster
        var d = data[j] - this.baseline[j];
        this.baseline[j] += d * (this.frames < this.warmup? 0.3 : d > 0? 0.004 : 0.05);
    }

    if (++this.frames < this.warmup) return;

    var now = Date.now();

    // Check if the signal we are parked on is still there
    if (this.current) {
        if (this.levelAt(data, this.current.freq, this.current.width, floor) >= this.snr - 3) this.current.seen = now;
        else if (now - this.current.seen > this.hang) this.current = null;
    }

    // Find all persistent new spikes
    var spikes = [];
    for (j = start; j < end; ++j) {
        if (this.hits[j] < this.persist) continue;
        // Group adjacent bins into one spike
        var k = j, top = j, sum = 0, wsum = 0;
        while (k < end && this.hits[k] >= this.persist) {
            if (data[k] > data[top]) top = k;
            var p = Math.pow(10, (data[k] - floor) / 10);
            sum += p; wsum += p * k;
            ++k;
        }
        var width = k - j;
        if (width <= len * this.maxWidth) {
            spikes.push({ freq: this.binToFreq(wsum / sum, len), width: width, score: data[top] - floor });
        }
        j = k;
    }

    // Log activity
    this.track(spikes, data, floor, now);

    // Find the strongest spike that is not locked out
    var best = null;
    for (j = 0; j < spikes.length; ++j) {
        if ((!best || spikes[j].score > best.score) && !this.isLockedOut(spikes[j].freq)) best = spikes[j];
    }

    if (!best || !this.autoTune) return;

    // Stay on the current signal unless a much stronger one appears
    if (this.current) {
        if (Math.abs(best.freq - this.current.freq) <= this.current.width * this.bw / len) return;
        if (now - this.current.tuned < this.minDwell) return;
        if (best.score < this.current.score + this.preempt) return;
    }

    best.tuned = best.seen = now;
    this.current = best;
    UI.setFrequency(best.freq);
    UI.showBubble(
        '<div style="text-align:center;">' + Utils.printFreq(Utils.snapFrequency(best.freq, tuning_step)) +
        '<div style="font-size:75%;">+' + Math.round(best.score) + ' dB</div></div>'
    );
};
