const test = require('node:test');
const assert = require('node:assert');
const load = require('./load');

const FFT = 8;

// Minimal chainable jQuery stand-in for the UI updates
function $() {
    const o = {};
    for (const m of ['toggleClass', 'hide', 'show', 'val', 'text', 'html', 'find', 'each', 'attr', 'css']) o[m] = () => o;
    o.is = () => false;
    return o;
}

function setup() {
    const clock = { now: 0 };
    const timeouts = [];   // pending setTimeout() callbacks
    const sent = [];       // messages sent to the server
    const drawn = [];      // waterfall lines drawn, as their first value
    const played = [];     // audio chunks sent to the speakers, as their first sample
    const ctx = load(['lib/AudioEngine.js', 'lib/WaterfallHistory.js'], {
        Date: class extends Date { static now() { return clock.now; } },
        $, Utils: { HHMMSS: () => '00:00:00' },
        waterfall_setup_done: 1, fft_size: FFT, center_freq: 145000000, bandwidth: 800,
        canvas_container: null,
        waterfall_add: d => drawn.push(d[0]), waterfall_clear: () => { drawn.length = 0; },
        spectrum: { update: () => {} },
        requestAnimationFrame: f => f(),
        setInterval: () => 1, clearInterval: () => {},
        // Timeouts only run when the test says so
        setTimeout: f => { timeouts.push(f); return timeouts.length; }, clearTimeout: () => {},
        ws: { send: m => sent.push(JSON.parse(m)) },
    });
    // Audio engine without a real audio device: output is captured
    const audio = Object.create(ctx.AudioEngine.prototype);
    Object.assign(audio, {
        audioNode: { port: { postMessage: b => played.push(b[0]) } },
        resampler: { process: b => b }, hdResampler: { process: b => b },
        audioBytes: { add: () => {} }, compression: 'none', recording: false,
        history: [], historyBytes: 0, historyMaxBytes: 1e9, historyMaxAge: 1e9, paused: false,
    });
    ctx.audioEngine = audio;
    const h = new ctx.WaterfallHistory();
    // One FFT line and one audio chunk every 100ms, both tagged with a sequence
    // number (in dB and in sample value) so that we can tell which ones are shown
    let seq = 0;
    const receive = () => {
        ++seq;
        const live = h.push(new Float32Array(FFT).fill(-seq));
        if (live) drawn.push(-seq);
        audio.pushAudio(new Int16Array([seq, seq]).buffer);
        return live;
    };
    // Receive live data for 100ms
    const step = () => { clock.now += 100; return receive(); };
    const run = (n) => { for (let i = 0; i < n; i++) step(); };
    // Advance the clock in 20ms steps like a browser would: live data
    // keeps arriving every 100ms, playback ticks run every 40ms
    const play = (ms) => {
        for (let t = 0; t < ms; t += 20) {
            clock.now += 20;
            if (clock.now % 100 == 0) receive();
            if (clock.now % 40 == 0) h.tick();
        }
    };
    const runTimeouts = () => { while (timeouts.length) timeouts.shift()(); };
    return { h, audio, drawn, played, run, step, play, ctx, sent, runTimeouts, receive };
}

test('live: lines are drawn and audio is played', () => {
    const s = setup();
    s.run(5);
    assert.ok(s.h.isLive());
    assert.deepStrictEqual(s.drawn, [-1, -2, -3, -4, -5]);
    assert.deepStrictEqual(s.played, [1, 2, 3, 4, 5]);
});

test('pause freezes waterfall and silences audio, pressing it again stays paused', () => {
    const s = setup();
    s.run(5);
    s.h.pause();
    s.played.length = 0;
    const before = s.drawn.slice();
    assert.strictEqual(s.step(), false, 'live data must not be shown while paused');
    s.run(5);
    assert.ok(!s.h.isLive());
    assert.deepStrictEqual(s.drawn, before, 'waterfall must not change while paused');
    assert.deepStrictEqual(s.played, [], 'no audio while paused');
    s.h.pause();
    assert.ok(!s.h.isLive(), 'pausing again must not return to live');
});

test('LIVE returns to live, with live audio', () => {
    const s = setup();
    s.run(5);
    s.h.pause();
    s.run(5);
    s.h.goLive();
    assert.ok(s.h.isLive());
    assert.strictEqual(s.drawn[s.drawn.length - 1], -10, 'shows newest line');
    s.played.length = 0;
    s.run(2);
    assert.deepStrictEqual(s.played, [11, 12]);
});

test('replay at 1x plays the recorded audio in step with the waterfall, not live audio', () => {
    const s = setup();
    s.run(100);            // 10 seconds of history
    s.h.skip(-5);          // back to line 50
    assert.ok(!s.h.isLive());
    s.drawn.length = 0;
    s.played.length = 0;
    s.h.setSpeed(1);
    s.play(2000);          // 2 seconds of playback, live data keeps coming in
    assert.ok(!s.h.isLive());
    assert.ok(s.played.length >= 18, 'played ' + s.played.length + ' chunks');
    // audio comes from the rewound time, not from the live feed (seq > 100)
    assert.ok(s.played.every(v => v > 50 && v <= 71), 'played ' + s.played.join(','));
    assert.ok(Math.abs(s.played.length - 20) <= 1, 'played ' + s.played.length + ' chunks in 2s, expected 20');
    // audio chunks are consecutive, without gaps or repeats
    s.played.forEach((v, i) => i && assert.strictEqual(v, s.played[i - 1] + 1));
    // and match the waterfall lines drawn meanwhile
    const lastLine = -s.drawn[s.drawn.length - 1];
    assert.ok(Math.abs(s.played[s.played.length - 1] - lastLine) <= 1, 'audio at ' + s.played[s.played.length - 1] + ', waterfall at ' + lastLine);
});

test('no audio when paused, rewinding or fast-forwarding', () => {
    const s = setup();
    s.run(100);
    s.h.skip(-5);
    s.played.length = 0;
    s.h.setSpeed(-4);
    s.play(500);
    s.h.setSpeed(4);
    s.play(500);
    s.h.setSpeed(1);
    s.h.pause();
    s.play(500);
    assert.deepStrictEqual(s.played, []);
});

test('pause during playback stops there, without returning to live', () => {
    const s = setup();
    s.run(100);
    s.h.skip(-5);
    s.h.setSpeed(1);
    s.play(1000);
    const cursor = s.h.cursor;
    s.h.pause();
    assert.ok(!s.h.isLive());
    assert.strictEqual(s.h.speed, 0);
    s.play(1000);
    assert.strictEqual(s.h.cursor, cursor, 'must stay where it was paused');
});

test('skip while live keeps playing, instead of getting stuck paused', () => {
    const s = setup();
    s.run(100);
    assert.ok(s.h.isLive());
    s.h.skip(-10);
    assert.ok(!s.h.isLive());
    assert.strictEqual(s.h.speed, 1, 'keeps playing after skipping back from live');
});

test('skip while playing back keeps playing, at the same speed', () => {
    const s = setup();
    s.run(200);            // 20 seconds of history
    s.h.skip(-10);         // back to 10s ago, well clear of the live edge
    s.h.setSpeed(4);
    s.h.skip(5);           // forward 5s, still short of the live edge
    assert.strictEqual(s.h.speed, 4, 'keeps playing at the same speed after skip');
    assert.ok(!s.h.isLive());
});

test('skip while paused stays paused', () => {
    const s = setup();
    s.run(100);
    s.h.pause();
    s.h.skip(-5);
    assert.strictEqual(s.h.speed, 0, 'must stay paused after skip');
    assert.ok(!s.h.isLive());
});

test('clicking the live waterfall jumps back to that moment and plays it', () => {
    const s = setup();
    s.run(100);            // 10 seconds of history, 100 lines
    assert.ok(s.h.isLive());
    assert.ok(s.h.clickSeek(30));
    assert.ok(!s.h.isLive());
    assert.strictEqual(s.h.speed, 1, 'starts playing immediately');
    assert.strictEqual(s.h.cursor, 100 - 1 - 30);
});

test('clicking right at the top of the live waterfall is just tuning', () => {
    const s = setup();
    s.run(100);
    assert.ok(s.h.clickSeek(2));
    assert.ok(s.h.isLive(), 'stays live for a click at the very top');
});

test('clicking below the buffered history is reported as out of range', () => {
    const s = setup();
    s.run(10);
    assert.ok(!s.h.clickSeek(500));
    assert.ok(s.h.isLive(), 'nothing changes when out of range');
});

test('fast-forward catches up and returns to live audio', () => {
    const s = setup();
    s.run(50);
    s.h.skip(-3);
    s.h.setSpeed(4);
    s.play(2000);
    assert.ok(s.h.isLive(), 'should have caught up');
    s.played.length = 0;
    s.run(2);
    assert.strictEqual(s.played.length, 2, 'live audio plays again');
});

test('frames recorded at another center frequency are remapped', () => {
    const s = setup();
    s.run(1);
    s.ctx.center_freq += 400;      // half the bandwidth up
    const d = s.h.frameData(0);
    // old spectrum's upper half now shows in the lower half, the rest is empty
    assert.deepStrictEqual(Array.from(d.slice(0, 4)), [-1, -1, -1, -1]);
    assert.deepStrictEqual(Array.from(d.slice(4)), [-200, -200, -200, -200]);
});

// Server side IQ replay (tune anywhere while listening to the past)

function serverSetup() {
    const s = setup();
    s.ctx.iq_buffer_seconds = 30;
    s.run(100);                 // 10 seconds of history
    s.h.skip(-5);
    s.h.setSpeed(1);
    s.runTimeouts();
    return s;
}

const starts = s => s.sent.filter(m => m.type === 'replay' && m.params.action === 'start');
const stops = s => s.sent.filter(m => m.type === 'replay' && m.params.action === 'stop');

test('playback asks the server to replay IQ from the right time', () => {
    const s = serverSetup();
    const req = starts(s);
    assert.strictEqual(req.length, 1);
    assert.ok(Math.abs(req[0].params.age_ms - 5000) <= 100, 'age ' + req[0].params.age_ms);
});

test('no audio while waiting for the server', () => {
    const s = serverSetup();
    s.played.length = 0;
    s.play(1000);
    assert.deepStrictEqual(s.played, [], 'neither live nor locally remembered audio');
});

test('once the server replays, its audio stream is played and not remembered', () => {
    const s = serverSetup();
    s.h.onReplayStatus({ id: starts(s)[0].params.id, active: true, error: null });
    s.played.length = 0;
    const remembered = s.audio.history.length;
    s.play(1000);
    // the incoming stream is now the server's replay, it must be heard
    assert.ok(s.played.length >= 9, 'played ' + s.played.length);
    assert.ok(s.played.every(v => v > 100), 'played what the server sent, not local audio: ' + s.played);
    assert.strictEqual(s.audio.history.length, remembered, 'replayed audio must not go into live history');
});

test('stale server answers are ignored', () => {
    const s = serverSetup();
    const first = starts(s)[0].params.id;
    s.h.skip(-2);              // seek: new request
    s.runTimeouts();
    s.h.onReplayStatus({ id: first, active: true, error: null });
    assert.strictEqual(s.h.serverReplay, 'pending');
});

test('falls back to local audio when the server can not replay', () => {
    const s = serverSetup();
    s.h.onReplayStatus({ id: starts(s)[0].params.id, active: false, error: 'No IQ data buffered' });
    s.played.length = 0;
    s.play(1000);
    assert.ok(s.played.length >= 9 && s.played.every(v => v <= 100), 'local audio: ' + s.played);
});

test('seeking repeatedly sends one request when it settles', () => {
    const s = serverSetup();
    for (let i = 0; i < 5; i++) s.h.skip(-1);
    s.runTimeouts();
    assert.strictEqual(starts(s).length, 2, 'initial request and one after seeking');
});

test('pause and LIVE stop the server replay', () => {
    const s = serverSetup();
    s.h.onReplayStatus({ id: starts(s)[0].params.id, active: true, error: null });
    s.h.pause();
    assert.strictEqual(stops(s).length, 1);
    s.played.length = 0;
    s.play(500);
    assert.deepStrictEqual(s.played, [], 'silent while paused');
    s.h.setSpeed(1);
    s.runTimeouts();
    s.h.goLive();
    assert.strictEqual(stops(s).length, 2);
    s.played.length = 0;
    const remembered = s.audio.history.length;
    s.run(2);
    assert.strictEqual(s.played.length, 2, 'live audio plays');
    assert.strictEqual(s.audio.history.length, remembered + 2, 'live audio is remembered again');
});

// Without server replay, only audio recorded at the current tuning may play

test('local replay never plays audio recorded at another frequency', () => {
    const s = setup();
    let tuning = '145000000 nfm';
    s.audio.tuningProvider = () => tuning;
    s.run(100);
    s.h.skip(-5);
    s.h.setSpeed(1);
    s.played.length = 0;
    s.play(1000);
    assert.ok(s.played.length >= 9, 'recorded frequency plays: ' + s.played.length);
    assert.strictEqual(s.h.localMismatch, false);
    // user tunes elsewhere: no audio from the old frequency
    tuning = '145500000 nfm';
    s.played.length = 0;
    s.play(1000);
    assert.deepStrictEqual(s.played, [], 'played audio recorded at another frequency');
    assert.strictEqual(s.h.localMismatch, true);
    // tuning back plays again
    tuning = '145000000 nfm';
    s.play(1000);
    assert.ok(s.played.length >= 9);
    assert.strictEqual(s.h.localMismatch, false);
});

test('play/pause button pauses, plays at 1x, and never returns to live', () => {
    const s = setup();
    s.run(100);
    s.h.togglePlay();                    // live: pause
    assert.ok(!s.h.isLive());
    assert.strictEqual(s.h.speed, 0);
    s.h.togglePlay();                    // paused: play at 1x
    assert.strictEqual(s.h.speed, 1);
    assert.ok(!s.h.isLive());
    s.h.togglePlay();                    // playing: pause again, not live
    assert.strictEqual(s.h.speed, 0);
    assert.ok(!s.h.isLive());
    s.h.setSpeed(-4);                    // rewinding: pause
    s.h.togglePlay();
    assert.strictEqual(s.h.speed, 0);
    assert.ok(!s.h.isLive());
});
