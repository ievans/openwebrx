const test = require('node:test');
const assert = require('node:assert');
const load = require('./load');

const N = 4096;
const CENTER = 145000000;
const BANDWIDTH = 2400000;

// Seeded random numbers, so that the tests are repeatable
function rng(seed) {
    return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
}

function setup() {
    let now = 0;
    const tuned = [];
    const ctx = load(['lib/SpikeScanner.js'], {
        center_freq: CENTER, bandwidth: BANDWIDTH, tuning_step: 1000,
        get_visible_freq_range: () => ({ start: CENTER - BANDWIDTH / 2, end: CENTER + BANDWIDTH / 2 }),
        UI: { setFrequency: f => tuned.push(f), showBubble: () => {} },
        Utils: { printFreq: f => '' + f, snapFrequency: (f, s) => Math.round(f / s) * s },
        Date: class extends Date { static now() { return now; } },
    });
    const random = rng(1);
    const scanner = new ctx.SpikeScanner();
    scanner.start();
    return {
        scanner, tuned,
        // Feed one FFT frame at time t (in tenths of a second, i.e. 10fps)
        frame(t, signals = []) {
            now = t * 100;
            const d = new Float32Array(N);
            for (let i = 0; i < N; i++) d[i] = -110 + random() * 6 - 3;
            for (const s of signals) for (let k = -s.w; k <= s.w; k++) d[s.bin + k] = Math.max(d[s.bin + k], s.p - Math.abs(k) * 2);
            scanner.update(d);
        },
        binOf: f => Math.round((f - CENTER) / BANDWIDTH * N + N / 2),
    };
}

const birdie = { bin: 1000, w: 1, p: -60 };

test('ignores constant carriers and short impulses', () => {
    const s = setup();
    for (let t = 0; t < 300; t++) {
        const sigs = [birdie];
        if (t % 37 == 0) sigs.push({ bin: 600, w: 400, p: -80 });   // wideband click
        if (t % 53 == 0) sigs.push({ bin: 3000, w: 2, p: -50 });    // narrow click
        s.frame(t, sigs);
    }
    assert.deepStrictEqual(s.tuned, []);
    assert.strictEqual(s.scanner.log.length, 0);
});

test('tunes to a new signal within a few frames', () => {
    const s = setup();
    for (let t = 0; t < 120; t++) s.frame(t, t >= 100 ? [birdie, { bin: 2000, w: 3, p: -85 }] : [birdie]);
    assert.strictEqual(s.tuned.length, 1);
    assert.ok(Math.abs(s.binOf(s.tuned[0]) - 2000) <= 1, 'tuned to bin ' + s.binOf(s.tuned[0]));
});

test('much stronger newcomer preempts, then returns after hang time', () => {
    const s = setup();
    const bins = [];
    for (let t = 0; t < 260; t++) {
        const sigs = [birdie];
        if (t >= 100) sigs.push({ bin: 2000, w: 3, p: -85 });
        if (t >= 150 && t < 200) sigs.push({ bin: 3500, w: 2, p: -60 });
        const before = s.tuned.length;
        s.frame(t, sigs);
        if (s.tuned.length > before) bins.push([t, s.binOf(s.tuned[s.tuned.length - 1])]);
    }
    assert.deepStrictEqual(bins.map(b => b[1]), [2000, 3500, 2000]);
    // back to the first signal after the 2 second hang time
    assert.ok(bins[2][0] >= 200 + 20 && bins[2][0] <= 200 + 25, 'returned at frame ' + bins[2][0]);
});

test('skipped signal stays skipped even if it jitters', () => {
    const s = setup();
    for (let t = 0; t < 110; t++) s.frame(t, t >= 100 ? [birdie, { bin: 2000, w: 0, p: -80 }] : [birdie]);
    assert.strictEqual(s.tuned.length, 1);
    assert.ok(s.scanner.lockoutCurrent());
    for (let t = 110; t < 200; t++) s.frame(t, [birdie, { bin: 2000 + (t % 2), w: t % 3 == 0 ? 1 : 0, p: -80 }]);
    assert.strictEqual(s.tuned.length, 1, 'tuned back to a skipped signal');
});

test('log records every new signal with correct duration', () => {
    const s = setup();
    for (let t = 0; t < 900; t++) {
        const sigs = [birdie];
        if (t >= 100 && t < 250) sigs.push({ bin: 2000, w: 3, p: -85 });   // 15s
        if (t >= 150 && t < 200) sigs.push({ bin: 3500, w: 2, p: -60 });   // 5s
        if (t >= 250 && t < 850) sigs.push({ bin: 2500, w: 2, p: -70 });   // 60s, outlasts baseline learning
        s.frame(t, sigs);
    }
    const log = s.scanner.log.slice().reverse().map(e => [s.binOf(e.freq), Math.round((e.last - e.start) / 100) / 10]);
    assert.strictEqual(log.length, 3);
    for (const [bin, expected] of [[2000, 15], [3500, 5], [2500, 60]]) {
        const e = log.find(l => Math.abs(l[0] - bin) <= 1);
        assert.ok(e, 'missing log entry for bin ' + bin);
        assert.ok(Math.abs(e[1] - expected) <= 0.5, 'bin ' + bin + ' lasted ' + e[1] + 's, expected ' + expected + 's');
    }
    const ids = s.scanner.log.map(e => e.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'log IDs must be unique');
});

test('log-only mode logs but never tunes', () => {
    const s = setup();
    s.scanner.setAutoTune(false);
    for (let t = 0; t < 200; t++) s.frame(t, t >= 100 ? [birdie, { bin: 2000, w: 3, p: -85 }] : [birdie]);
    assert.deepStrictEqual(s.tuned, []);
    assert.strictEqual(s.scanner.log.length, 1);
});

test('CSV export', () => {
    const s = setup();
    for (let t = 0; t < 150; t++) s.frame(t, t >= 100 ? [birdie, { bin: 2000, w: 3, p: -85 }] : [birdie]);
    const lines = s.scanner.getLogCsv().trim().split('\n');
    assert.strictEqual(lines[0], 'start_utc,end_utc,frequency_hz,peak_db_above_floor,duration_s,width_hz');
    assert.strictEqual(lines.length, 2);
    const cols = lines[1].split(',');
    assert.strictEqual(cols.length, 6);
    assert.ok(Math.abs(Number(cols[2]) - (CENTER + (2000 / N - 0.5) * BANDWIDTH)) < BANDWIDTH / N);
});
