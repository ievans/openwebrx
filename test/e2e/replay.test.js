// Waterfall pause, LIVE, rewind and playback, including what is heard
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

let browser;
before(async () => { browser = await h.launch(); });
after(async () => { await browser.close(); });

const silent = a => a.buffers === 0 || a.rms === 0;
const audible = a => a.buffers > 0 && a.rms > 0.001;

test('pause, LIVE, keys and playback control waterfall and audio', async () => {
    const page = await h.openReceiver(browser);
    await page.waitForTimeout(4000);    // build up some history

    let s = await h.historyState(page);
    assert.ok(s.live && s.liveLit && !s.pauseLit && !s.badge, 'starts live: ' + JSON.stringify(s));
    assert.ok(audible(await h.audioOutput(page)), 'live audio plays');
    assert.ok(await h.waterfallMoving(page), 'live waterfall moves');

    await page.click('.openwebrx-history-button');
    s = await h.historyState(page);
    assert.ok(!s.live && s.speed === 0 && s.pauseLit && !s.liveLit, 'pause button pauses: ' + JSON.stringify(s));
    assert.match(s.badge, /REPLAY .* audio paused/);
    assert.ok(!(await h.waterfallMoving(page)), 'paused waterfall is frozen');
    assert.ok(silent(await h.audioOutput(page)), 'no audio while paused');

    await page.click('.openwebrx-history-button');
    assert.ok(!(await h.historyState(page)).live, 'pause button again does not return to live');

    await page.click('text=-10s');
    await page.click('.openwebrx-history-speed[data-speed="1"]');
    s = await h.historyState(page);
    assert.ok(!s.live && s.speed === 1, 'playing history: ' + JSON.stringify(s));
    assert.match(s.badge, /replaying audio/);
    assert.ok(await h.waterfallMoving(page), 'waterfall moves during playback');
    assert.ok(audible(await h.audioOutput(page)), 'recorded audio plays during playback');

    await page.click('.openwebrx-history-button');
    s = await h.historyState(page);
    assert.ok(!s.live && s.speed === 0, 'pause during playback stays in history: ' + JSON.stringify(s));
    assert.ok(!(await h.waterfallMoving(page)), 'frozen after pausing playback');
    assert.ok(silent(await h.audioOutput(page)), 'no audio after pausing playback');

    await page.click('.openwebrx-live-button');
    s = await h.historyState(page);
    assert.ok(s.live && s.liveLit && !s.badge, 'LIVE button returns to live: ' + JSON.stringify(s));
    assert.ok(audible(await h.audioOutput(page)), 'live audio after LIVE');
    assert.ok(await h.waterfallMoving(page), 'waterfall moves after LIVE');

    await page.keyboard.press('w');
    assert.ok(!(await h.historyState(page)).live, 'W pauses');
    await page.keyboard.press('w');
    assert.ok(!(await h.historyState(page)).live, 'W again stays paused');
    await page.keyboard.press('End');
    assert.ok((await h.historyState(page)).live, 'End returns to live');

    await page.click('.openwebrx-history-speed[data-speed="-4"]');
    s = await h.historyState(page);
    assert.ok(!s.live && s.speed === -4, 'rewinding: ' + JSON.stringify(s));
    assert.ok(silent(await h.audioOutput(page, 600)), 'no audio while rewinding');
    await page.click('#openwebrx-history-overlay');
    assert.ok((await h.historyState(page)).live, 'clicking the REPLAY badge returns to live');

    await page.click('text=-10s');
    await page.click('.openwebrx-history-speed[data-speed="4"]');
    await page.waitForFunction(() => wfHistory.isLive(), null, { timeout: 10000 });
    assert.ok(audible(await h.audioOutput(page)), 'fast-forward catches up to live audio');

    assert.deepStrictEqual(page.errors, []);
    await page.close();
});

test('playback plays the audio recorded at that time, not the live feed', async () => {
    const page = await h.openReceiver(browser);
    // Tuned to the burst in FM, audio is quiet while it is on and noisy while
    // it is off, so loudness over time follows the 3s on / 3s off pattern
    await page.evaluate(f => { UI.setModulation('nfm'); UI.setFrequency(f, false); }, h.BURST);
    await page.waitForTimeout(16000);
    const r = await page.evaluate(async () => {
        wfHistory.skip(-10);
        $('.openwebrx-history-speed[data-speed="1"]').click();
        const offset = Date.now() - wfHistory.playT;
        const start = Date.now();
        await new Promise(res => setTimeout(res, 8000));
        // What the live feed sounded like over time, from the engine's audio history
        const live = audioEngine.history.map(c => { let s = 0; for (const v of c.pcm) s += v * v; return [c.t, Math.sqrt(s / c.pcm.length)]; });
        return { offset, start, live, out: window.__audio.filter(x => x[0] > start + 500), replaying: !wfHistory.isLive() && wfHistory.speed === 1 };
    });
    assert.ok(r.replaying, 'still replaying');

    // Level (dB) of the live feed at a given time, from 16bit samples
    const levelAt = t => {
        let v = null;
        for (const x of r.live) { if (x[0] <= t) v = x[1]; else break; }
        return v === null ? null : 20 * Math.log10(v / 32768 + 1e-9);
    };
    let n = 0, recorded = 0, live = 0;
    for (const [t, rms] of r.out) {
        const out = 20 * Math.log10(rms + 1e-9);
        const then = levelAt(t - r.offset), now = levelAt(t);
        if (then === null || now === null) continue;
        n++;
        if (Math.abs(out - then) < 3) recorded++;
        if (Math.abs(out - now) < 3) live++;
    }
    const pct = x => Math.round(100 * x / n) + '%';
    console.log('# replayed audio within 3dB of recorded: ' + pct(recorded) + ', of live: ' + pct(live) + ' (' + n + ' buffers)');
    assert.ok(n > 40, 'compared ' + n + ' buffers');
    assert.ok(recorded / n >= 0.9, 'within 3dB of the recorded audio only ' + pct(recorded));
    assert.ok(live / n <= 0.6, 'within 3dB of the live audio ' + pct(live));
    assert.deepStrictEqual(page.errors, []);
    await page.close();
});
