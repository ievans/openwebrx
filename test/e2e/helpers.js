// Shared helpers for the end-to-end tests, see run.sh
const { chromium } = require('playwright');

const URL = process.env.OWRX_URL || 'http://127.0.0.1:18073';
const FILES = process.env.OWRX_FILES;

// The fake SDR (bin/perseustest) puts signals at these frequencies
const CENTER = 145000000;
const CARRIER = CENTER + 30000;    // always on
const BURST = CENTER - 60000;      // on/off every 3 seconds

async function launch() {
    return chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ['--autoplay-policy=no-user-gesture-required'],
    });
}

// Open the receiver page with audio running and the Scan & IQ Recording
// sections visible, and tap the audio output to measure what would be heard.
async function openReceiver(browser) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.errors = [];
    page.on('pageerror', e => page.errors.push(e.message));
    await page.goto(URL);
    await page.waitForFunction(() => typeof audioEngine !== 'undefined' && audioEngine && audioEngine.audioNode && typeof wfHistory !== 'undefined' && wfHistory.frames.length > 5, null, { timeout: 30000 });
    await page.click('#openwebrx-autoplay-overlay').catch(() => {});
    await page.evaluate(() => {
        window.__audio = [];   // [wall time, rms] of every buffer sent to the speakers
        const node = audioEngine.audioNode;
        const tap = b => {
            let s = 0, n = 0;
            for (const v of b) if (Number.isFinite(v)) { s += v * v; n++; }
            // the resampler may produce empty buffers, those are not silence
            if (n) window.__audio.push([Date.now(), Math.sqrt(s / n)]);
        };
        if (node.port) {
            const post = node.port.postMessage.bind(node.port);
            node.port.postMessage = b => { tap(b); post(b); };
        } else {
            const push = audioEngine.audioBuffers.push.bind(audioEngine.audioBuffers);
            audioEngine.audioBuffers.push = b => { tap(b); return push(b); };
        }
        UI.toggleSection(document.getElementById('openwebrx-section-scan'), true);
        UI.toggleSection(document.getElementById('openwebrx-section-replay'), true);
    });
    return page;
}

// Loudness of audio sent to the speakers during the next MS milliseconds
async function audioOutput(page, ms = 1200) {
    const start = await page.evaluate(() => Date.now());
    await page.waitForTimeout(ms);
    return page.evaluate(start => {
        const b = window.__audio.filter(x => x[0] >= start);
        return { buffers: b.length, rms: b.length ? Math.sqrt(b.reduce((a, x) => a + x[1] * x[1], 0) / b.length) : 0 };
    }, start);
}

// Fingerprint of the waterfall pixels and their scroll positions
function waterfall(page) {
    return page.evaluate(() => canvases.map(c =>
        c.style.transform + ':' + c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data.reduce((a, b, i) => (a + b * (i % 97)) % 1000003, 0)
    ).join('|'));
}

async function waterfallMoving(page) {
    const a = await waterfall(page);
    await page.waitForTimeout(1200);
    return a !== await waterfall(page);
}

// The waterfall never freezes: it always shows live data, and a moving
// "playhead" line marks the replay position on top of it instead. The
// banner is a plain "back to live" prompt, so its text barely varies -
// tests mostly care whether it is shown at all.
function historyState(page) {
    return page.evaluate(() => ({
        live: wfHistory.isLive(),
        speed: wfHistory.speed,
        playheadVisible: $('#openwebrx-replay-position-marker').is(':visible'),
        badge: $('#openwebrx-history-overlay').is(':visible') ? $('#openwebrx-history-overlay').text().replace(/\s+/g, ' ').trim() : '',
    }));
}

// Level in dBFS of a tone at OFFSET Hz in complex float32 IQ data
function toneLevel(iq, rate, offset, start, n = 5000) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
        const p = -2 * Math.PI * offset * i / rate;
        const x = iq[2 * (start + i)], y = iq[2 * (start + i) + 1];
        re += x * Math.cos(p) - y * Math.sin(p);
        im += x * Math.sin(p) + y * Math.cos(p);
    }
    return 20 * Math.log10(Math.hypot(re, im) / n + 1e-12);
}

module.exports = { URL, FILES, CENTER, CARRIER, BURST, launch, openReceiver, audioOutput, waterfall, waterfallMoving, historyState, toneLevel };
