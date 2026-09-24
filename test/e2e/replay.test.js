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
    assert.ok(s.live && !s.badge && !s.playheadVisible, 'starts live, no badge or playhead: ' + JSON.stringify(s));
    assert.ok(audible(await h.audioOutput(page)), 'live audio plays');
    assert.ok(await h.waterfallMoving(page), 'live waterfall moves');

    // Q/E (-10s/+10s) must not get stuck paused if it was playing beforehand
    await page.keyboard.press('q');
    s = await h.historyState(page);
    assert.ok(!s.live && s.speed === 1, '-10s while live keeps playing: ' + JSON.stringify(s));
    assert.ok(await h.waterfallMoving(page), 'waterfall keeps moving after -10s');
    await page.keyboard.press('End');

    await page.keyboard.press('w');   // W: play/pause
    s = await h.historyState(page);
    assert.ok(!s.live && s.speed === 0, 'W pauses: ' + JSON.stringify(s));
    assert.ok(s.badge, 'banner prompts back to live');
    assert.ok(await h.waterfallMoving(page), 'the waterfall itself keeps moving, only audio pauses');
    assert.ok(s.playheadVisible, 'playhead marker appears once paused');
    assert.ok(silent(await h.audioOutput(page)), 'no audio while paused');

    await page.keyboard.press('q');
    assert.ok(!(await h.historyState(page)).live, '-10s stays in history');
    await page.keyboard.press('w');   // W again: play history at 1x
    // Audio source settles once the server answers the replay request
    await page.waitForFunction(() => ['active', 'failed'].includes(wfHistory.serverReplay), null, { timeout: 5000 });
    s = await h.historyState(page);
    assert.ok(!s.live && s.speed === 1, 'W plays history at 1x: ' + JSON.stringify(s));
    assert.ok(await h.waterfallMoving(page), 'waterfall moves during playback');
    assert.ok(audible(await h.audioOutput(page)), 'recorded audio plays during playback');

    await page.keyboard.press('w');
    s = await h.historyState(page);
    assert.ok(!s.live && s.speed === 0, 'pausing playback stays in history: ' + JSON.stringify(s));
    assert.ok(await h.waterfallMoving(page), 'the waterfall keeps moving, only audio pauses');
    assert.ok(s.playheadVisible, 'playhead marker still shown while paused');
    assert.ok(silent(await h.audioOutput(page)), 'no audio after pausing playback');

    await page.keyboard.press('End');   // END: return to live
    s = await h.historyState(page);
    assert.ok(s.live && !s.badge, 'END returns to live: ' + JSON.stringify(s));
    assert.ok(audible(await h.audioOutput(page)), 'live audio after LIVE');
    assert.ok(await h.waterfallMoving(page), 'waterfall moves after LIVE');
    assert.ok(!s.playheadVisible, 'playhead hides once live');

    await page.keyboard.press('w');
    s = await h.historyState(page);
    assert.ok(!s.live && s.speed === 0, 'W pauses');
    await page.keyboard.press('w');
    s = await h.historyState(page);
    assert.ok(!s.live && s.speed === 1, 'W again plays history, does not return to live');
    await page.keyboard.press('End');
    assert.ok((await h.historyState(page)).live, 'End returns to live');

    // No dedicated UI for 4x rewind/fast-forward any more, drive it directly
    await page.evaluate(() => wfHistory.setSpeed(-4));
    s = await h.historyState(page);
    assert.ok(!s.live && s.speed === -4, 'rewinding: ' + JSON.stringify(s));
    assert.ok(silent(await h.audioOutput(page, 600)), 'no audio while rewinding');
    await page.click('#openwebrx-history-overlay');
    assert.ok((await h.historyState(page)).live, 'clicking the banner returns to live');

    await page.keyboard.press('q');
    await page.evaluate(() => wfHistory.setSpeed(4));
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

// Click the waterfall at the given frequency, like a user tuning there.
// y is how far down from the top (i.e. how far back in time) to click.
async function clickWaterfall(page, freq, y = 100) {
    const box = await page.locator('#webrx-canvas-container').boundingBox();
    const x = await page.evaluate(f => (f - (center_freq - bandwidth / 2)) / bandwidth, freq);
    await page.mouse.click(box.x + x * box.width, box.y + y);
}

test('clicking the live waterfall rewinds to that moment and plays it', async () => {
    const page = await h.openReceiver(browser);
    // Build up enough history that clicking well below the top is safely
    // within the buffer (fake SDR runs at the default 9 fft fps)
    await page.waitForTimeout(15000);
    assert.ok((await h.historyState(page)).live, 'starts live');

    await clickWaterfall(page, h.CARRIER, 80);

    const s = await h.historyState(page);
    assert.ok(!s.live && s.speed === 1, 'click rewinds and plays: ' + JSON.stringify(s));
    assert.ok(await h.waterfallMoving(page), 'waterfall keeps moving after the click');
    assert.ok(s.playheadVisible, 'playhead marker appears after the click');
    const tuned = await page.evaluate(() => UI.getFrequency());
    assert.ok(Math.abs(tuned - h.CARRIER) < 3000, 'also tunes to the clicked frequency: ' + tuned);

    await page.keyboard.press('End');
    assert.deepStrictEqual(page.errors, []);
    await page.close();
});

test('the IQ buffer limit is marked on the waterfall once there is enough history', async () => {
    const page = await h.openReceiver(browser);
    await page.waitForTimeout(15000);    // more than the 12s IQ buffer configured for this test
    const marker = await page.evaluate(() => ({
        visible: $('#openwebrx-iq-buffer-marker').is(':visible'),
        top: parseFloat($('#openwebrx-iq-buffer-marker').css('top')) || 0,
        label: $('#openwebrx-iq-buffer-marker span').text(),
    }));
    assert.ok(marker.visible, 'buffer marker shows once there is more history than the IQ buffer');
    assert.ok(marker.top > 0, 'marker is placed below the top of the waterfall: ' + JSON.stringify(marker));
    assert.match(marker.label, /buffer at \d+s/, 'marker is labelled: ' + JSON.stringify(marker));
    await page.close();
});

// Every distinct position SELECTOR took on screen, checked on every frame
// the browser painted during the next MS milliseconds
function markerPositions(page, selector, ms) {
    return page.evaluate(([selector, ms]) => new Promise(resolve => {
        const tops = new Set();
        const end = performance.now() + ms;
        const sample = () => {
            const $m = $(selector);
            tops.add($m.is(':visible') ? $m.css('top') : 'hidden');
            if (performance.now() < end) requestAnimationFrame(sample); else resolve([...tops]);
        };
        requestAnimationFrame(sample);
    }), [selector, ms]);
}

test('playhead and IQ buffer lines hold still on screen while replaying at 1x', async () => {
    const page = await h.openReceiver(browser);
    await page.waitForTimeout(15000);    // more than the 12s IQ buffer
    await clickWaterfall(page, h.CARRIER, 40);
    await page.waitForTimeout(500);
    const [playhead, buffer] = await Promise.all([
        markerPositions(page, '#openwebrx-replay-position-marker', 6000),
        markerPositions(page, '#openwebrx-iq-buffer-marker', 6000),
    ]);
    assert.deepStrictEqual(playhead, ['40px'], 'playhead line moved: ' + playhead);
    assert.strictEqual(buffer.length, 1, 'IQ buffer line moved: ' + buffer);
    assert.notStrictEqual(buffer[0], 'hidden');
    await page.keyboard.press('End');
    assert.deepStrictEqual(page.errors, []);
    await page.close();
});

test('clicking below the IQ buffer line snaps playback to it, and audio replays', async () => {
    const page = await h.openReceiver(browser);
    await page.evaluate(f => { UI.setModulation('nfm'); UI.setFrequency(f, false); }, h.CARRIER);
    await page.waitForTimeout(15000);
    const line = await page.evaluate(() => $('#openwebrx-iq-buffer-marker').css('top'));
    assert.ok(parseFloat(line) > 0 && parseFloat(line) < 130, 'buffer line placed: ' + line);

    await clickWaterfall(page, h.CARRIER, 130);   // well below the line

    assert.strictEqual(await page.evaluate(() => $('#openwebrx-replay-position-marker').css('top')), line, 'playhead snapped to the buffer line');
    const labelsOverlap = await page.evaluate(() => {
        const p = $('#openwebrx-replay-position-marker span')[0].getBoundingClientRect();
        const b = $('#openwebrx-iq-buffer-marker span')[0].getBoundingClientRect();
        return !(p.right <= b.left || b.right <= p.left || p.bottom <= b.top || b.bottom <= p.top);
    });
    assert.ok(!labelsOverlap, 'playhead and buffer labels overlap');
    await page.waitForFunction(() => wfHistory.serverReplay !== 'pending', null, { timeout: 5000 });
    const replay = await page.evaluate(() => ({ state: wfHistory.serverReplay, error: wfHistory.replayError }));
    assert.strictEqual(replay.state, 'active', 'server replays from the snapped position: ' + JSON.stringify(replay));
    assert.ok(audible(await h.audioOutput(page)), 'replayed audio plays');

    await page.keyboard.press('End');
    assert.deepStrictEqual(page.errors, []);
    await page.close();
});

test('clicking further down while already replaying also seeks, relative to now', async () => {
    const page = await h.openReceiver(browser);
    await page.evaluate(f => { UI.setModulation('nfm'); UI.setFrequency(f, false); }, h.CARRIER);
    await page.waitForTimeout(15000);
    await page.evaluate(() => wfHistory.skip(-3));   // keeps playing
    await page.waitForFunction(() => wfHistory.serverReplay === 'active', null, { timeout: 5000 });
    const before = await page.evaluate(() => wfHistory.playT);

    // Well below the dead zone: retunes AND seeks, relative to live "now",
    // not to the previous (3s back) position - so this jumps much further
    await clickWaterfall(page, h.BURST, 80);

    const after = await page.evaluate(() => wfHistory.playT);
    assert.ok(after < before - 3000, 'clicking further down also rewinds: before=' + before + ' after=' + after);
    assert.ok(!(await h.historyState(page)).live, 'still replaying');
    const tuned = await page.evaluate(() => UI.getFrequency());
    assert.ok(Math.abs(tuned - h.BURST) < 3000, 'also tunes to the clicked frequency: ' + tuned);
    const position = await page.evaluate(() => ({
        visible: $('#openwebrx-replay-position-marker').is(':visible'),
        label: $('#openwebrx-replay-position-marker span').text(),
    }));
    assert.match(position.label, /playhead at \d+s/, 'position marker is labelled: ' + JSON.stringify(position));

    await page.keyboard.press('End');
    assert.deepStrictEqual(page.errors, []);
    await page.close();
});

test('while replaying, tune anywhere and hear that frequency as it was then', async () => {
    const page = await h.openReceiver(browser);
    // Listen live to the steady carrier only, never to the burst
    await page.evaluate(f => { UI.setModulation('nfm'); UI.setFrequency(f, false); }, h.CARRIER);
    await page.waitForTimeout(15000);
    // About 9 seconds back (with latency): 1.5 periods of the burst, so
    // the past and live burst are in opposite states and easy to tell apart
    await page.evaluate(() => wfHistory.skip(-8.5));   // keeps playing
    await page.waitForFunction(() => wfHistory.serverReplay === 'active', null, { timeout: 5000 });
    // Now tune to the burst by clicking it on the waterfall, right at the
    // top (dead zone) so this only retunes and does not also seek
    await clickWaterfall(page, h.BURST, 2);
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
    await page.keyboard.press('End');
    const liveStart = await page.evaluate(() => Date.now());
    await page.waitForTimeout(6000);
    const liveOut = await page.evaluate(start => window.__audio.filter(x => x[0] > start + 1000), liveStart);
    const l = followsBurst(liveOut, age);
    assert.ok(l.live >= 90, 'after LIVE, follows the live burst only ' + Math.round(l.live) + '%');
    assert.deepStrictEqual(page.errors, []);
    await page.close();
});

test('skipping back past the IQ buffer stops at its line, where the server still replays', async () => {
    const page = await h.openReceiver(browser);
    await page.evaluate(f => { UI.setModulation('nfm'); UI.setFrequency(f, false); }, h.BURST);
    await page.waitForTimeout(20000);
    // 15 seconds back is older than the server's 12 second IQ buffer
    await page.evaluate(() => wfHistory.skip(-15));   // keeps playing
    const pos = await page.evaluate(() => ({
        playhead: $('#openwebrx-replay-position-marker').css('top'),
        line: $('#openwebrx-iq-buffer-marker').css('top'),
        speed: wfHistory.speed,
    }));
    assert.strictEqual(pos.playhead, pos.line, 'stopped at the buffer line: ' + JSON.stringify(pos));
    assert.strictEqual(pos.speed, 1);
    await page.waitForFunction(() => wfHistory.serverReplay !== 'pending', null, { timeout: 5000 });
    assert.strictEqual(await page.evaluate(() => wfHistory.serverReplay), 'active',
        'server replays: ' + await page.evaluate(() => wfHistory.replayError));
    const age = await page.evaluate(() => Date.now() - wfHistory.playT);
    const start = await page.evaluate(() => Date.now());
    await page.waitForTimeout(8000);
    const out = await page.evaluate(start => window.__audio.filter(x => x[0] > start + 1000), start);
    const r = followsBurst(out, age);
    console.log('# at the buffer line: audio follows the burst as it was ' + (age / 1000).toFixed(1) + 's ago: ' + Math.round(r.past) + '%, live: ' + Math.round(r.live) + '% (' + r.n + ' buffers)');
    assert.ok(r.n > 30, 'compared ' + r.n + ' buffers');
    assert.ok(r.past >= 90, 'follows the past burst only ' + Math.round(r.past) + '%');
    await page.keyboard.press('End');
    assert.deepStrictEqual(page.errors, []);
    await page.close();
});
