// Waterfall pause, LIVE, rewind and playback, including what is heard
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

let browser;
before(async () => { browser = await h.launch(); });
after(async () => { await browser.close(); });

const silent = a => a.buffers === 0 || a.rms === 0;
const audible = a => a.buffers > 0 && a.rms > 0.001;

test('play/pause, LIVE, keys and playback control waterfall and audio', async () => {
    const page = await h.openReceiver(browser);
    await page.waitForTimeout(4000);    // build up some history

    let s = await h.historyState(page);
    assert.ok(s.live && s.liveLit && !s.pauseLit && !s.playIcon && !s.badge, 'starts live, showing pause: ' + JSON.stringify(s));
    assert.ok(audible(await h.audioOutput(page)), 'live audio plays');
    assert.ok(await h.waterfallMoving(page), 'live waterfall moves');

    await page.click('.openwebrx-history-button');
    s = await h.historyState(page);
    assert.ok(!s.live && s.speed === 0 && s.pauseLit && s.playIcon && !s.liveLit, 'pauses, now showing play: ' + JSON.stringify(s));
    assert.match(s.badge, /REPLAY .* audio paused/);
    assert.ok(!(await h.waterfallMoving(page)), 'paused waterfall is frozen');
    assert.ok(silent(await h.audioOutput(page)), 'no audio while paused');

    await page.click('text=-10s');
    assert.ok(!(await h.historyState(page)).live, '-10s stays in history');
    await page.click('.openwebrx-history-button');
    // Audio source settles once the server answers the replay request
    await page.waitForFunction(() => ['active', 'failed'].includes(wfHistory.serverReplay), null, { timeout: 5000 });
    s = await h.historyState(page);
    assert.ok(!s.live && s.speed === 1 && !s.playIcon, 'play/pause plays history at 1x, showing pause: ' + JSON.stringify(s));
    assert.match(s.badge, /replaying audio/);
    assert.ok(await h.waterfallMoving(page), 'waterfall moves during playback');
    assert.ok(audible(await h.audioOutput(page)), 'recorded audio plays during playback');

    await page.click('.openwebrx-history-button');
    s = await h.historyState(page);
    assert.ok(!s.live && s.speed === 0 && s.playIcon, 'pausing playback stays in history: ' + JSON.stringify(s));
    assert.ok(!(await h.waterfallMoving(page)), 'frozen after pausing playback');
    assert.ok(silent(await h.audioOutput(page)), 'no audio after pausing playback');

    await page.click('.openwebrx-live-button');
    s = await h.historyState(page);
    assert.ok(s.live && s.liveLit && !s.badge, 'LIVE button returns to live: ' + JSON.stringify(s));
    assert.ok(audible(await h.audioOutput(page)), 'live audio after LIVE');
    assert.ok(await h.waterfallMoving(page), 'waterfall moves after LIVE');

    await page.keyboard.press('w');
    s = await h.historyState(page);
    assert.ok(!s.live && s.speed === 0, 'W pauses');
    await page.keyboard.press('w');
    s = await h.historyState(page);
    assert.ok(!s.live && s.speed === 1, 'W again plays history, does not return to live');
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

// The fake SDR's burst is on during even 3 second periods of wall clock
// time. Tuned to it in FM, audio is quiet while it is on (a strong carrier)
// and loud noise while it is off.
const burstOn = t => Math.floor(t / 3000) % 2 === 0;
const nearSwitch = t => { const p = t % 3000; return p < 400 || p > 2600; };

// Compare audio loudness over time with the burst's state AGE ms earlier
// and at the same time. Returns percentages of matching audio buffers.
function followsBurst(out, age) {
    let n = 0, past = 0, live = 0;
    for (const [t, rms] of out) {
        if (nearSwitch(t - age) || nearSwitch(t)) continue;
        const quiet = rms < 0.05;
        n++;
        if (quiet === burstOn(t - age)) past++;
        if (quiet === burstOn(t)) live++;
    }
    return { n, past: 100 * past / n, live: 100 * live / n };
}

// Click the waterfall at the given frequency, like a user tuning there
async function clickWaterfall(page, freq) {
    const box = await page.locator('#webrx-canvas-container').boundingBox();
    const x = await page.evaluate(f => (f - (center_freq - bandwidth / 2)) / bandwidth, freq);
    await page.mouse.click(box.x + x * box.width, box.y + 100);
}

test('while replaying, tune anywhere and hear that frequency as it was then', async () => {
    const page = await h.openReceiver(browser);
    // Listen live to the steady carrier only, never to the burst
    await page.evaluate(f => { UI.setModulation('nfm'); UI.setFrequency(f, false); }, h.CARRIER);
    await page.waitForTimeout(15000);
    // About 9 seconds back (with latency): 1.5 periods of the burst, so
    // the past and live burst are in opposite states and easy to tell apart
    await page.evaluate(() => wfHistory.skip(-8.5));
    await page.click('.openwebrx-history-button');   // paused after seeking: play
    await page.waitForFunction(() => wfHistory.serverReplay === 'active', null, { timeout: 5000 });
    assert.match((await h.historyState(page)).badge, /tune anywhere/);
    // Now tune to the burst by clicking it on the waterfall
    await clickWaterfall(page, h.BURST);
    const tuned = await page.evaluate(() => UI.getFrequency());
    assert.ok(Math.abs(tuned - h.BURST) < 3000, 'tuned to ' + tuned);
    const age = await page.evaluate(() => Date.now() - wfHistory.playT);
    const start = await page.evaluate(() => Date.now());
    await page.waitForTimeout(8000);
    const out = await page.evaluate(start => window.__audio.filter(x => x[0] > start + 1000), start);
    const r = followsBurst(out, age);
    console.log('# tune anywhere: audio follows the burst as it was ' + (age / 1000).toFixed(1) + 's ago: ' + Math.round(r.past) + '%, live: ' + Math.round(r.live) + '% (' + r.n + ' buffers)');
    assert.ok(r.n > 30, 'compared ' + r.n + ' buffers');
    assert.ok(r.past >= 90, 'follows the past burst only ' + Math.round(r.past) + '%');
    assert.ok(r.live <= 60, 'follows the live burst ' + Math.round(r.live) + '%');
    assert.ok(!(await h.historyState(page)).live, 'still replaying');
    // Back to live: audio follows the live burst again
    await page.click('.openwebrx-live-button');
    const liveStart = await page.evaluate(() => Date.now());
    await page.waitForTimeout(6000);
    const liveOut = await page.evaluate(start => window.__audio.filter(x => x[0] > start + 1000), liveStart);
    const l = followsBurst(liveOut, age);
    assert.ok(l.live >= 90, 'after LIVE, follows the live burst only ' + Math.round(l.live) + '%');
    assert.deepStrictEqual(page.errors, []);
    await page.close();
});

test('beyond the IQ buffer, playback falls back to the recorded audio of the tuned frequency', async () => {
    const page = await h.openReceiver(browser);
    await page.evaluate(f => { UI.setModulation('nfm'); UI.setFrequency(f, false); }, h.BURST);
    await page.waitForTimeout(20000);
    // 15 seconds back is older than the server's 12 second IQ buffer
    await page.evaluate(() => wfHistory.skip(-15));
    await page.click('.openwebrx-history-button');   // paused after seeking: play
    await page.waitForFunction(() => wfHistory.serverReplay === 'failed', null, { timeout: 5000 });
    assert.match((await h.historyState(page)).badge, /tuned frequency only \(No IQ data buffered from \d+ seconds ago\)/);
    const age = await page.evaluate(() => Date.now() - wfHistory.playT);
    const start = await page.evaluate(() => Date.now());
    await page.waitForTimeout(8000);
    const out = await page.evaluate(start => window.__audio.filter(x => x[0] > start + 1000), start);
    const r = followsBurst(out, age);
    console.log('# fallback: audio follows the burst as it was ' + (age / 1000).toFixed(1) + 's ago: ' + Math.round(r.past) + '%, live: ' + Math.round(r.live) + '% (' + r.n + ' buffers)');
    assert.ok(r.n > 30, 'compared ' + r.n + ' buffers');
    assert.ok(r.past >= 90, 'follows the recorded burst only ' + Math.round(r.past) + '%');
    assert.ok(r.live <= 60, 'follows the live burst ' + Math.round(r.live) + '%');

    // Tuning elsewhere: nothing was recorded there, so nothing must play
    await clickWaterfall(page, h.CARRIER);
    await page.waitForTimeout(500);
    const other = await h.audioOutput(page, 2000);
    assert.ok(other.buffers === 0 || other.rms === 0, 'played audio from another frequency: ' + JSON.stringify(other));
    await page.waitForTimeout(300);
    assert.match((await h.historyState(page)).badge, /no recorded audio at this frequency/);
    assert.deepStrictEqual(page.errors, []);
    await page.close();
});
