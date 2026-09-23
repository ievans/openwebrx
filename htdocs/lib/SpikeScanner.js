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
    this.reset();
}

SpikeScanner.prototype.reset = function() {
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
    return !this.running;
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
        var c = Math.round(((this.current.freq - this.cf) / this.bw + 0.5) * len);
        var w = Math.max(1, Math.ceil(this.current.width / 2));
        var peak = -1000;
        for (j = Math.max(0, c - w); j <= Math.min(len - 1, c + w); ++j) peak = Math.max(peak, data[j]);
        if (peak - floor >= this.snr - 3) this.current.seen = now;
        else if (now - this.current.seen > this.hang) this.current = null;
    }

    // Find the strongest persistent new spike
    var best = null;
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
            var freq = this.binToFreq(wsum / sum, len);
            var score = data[top] - floor;
            if ((!best || score > best.score) && !this.isLockedOut(freq)) {
                best = { freq: freq, width: width, score: score };
            }
        }
        j = k;
    }

    if (!best) return;

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
