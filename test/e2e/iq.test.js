// Server side IQ recording and time-shift buffer produce correct SigMF files
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

let browser;
before(async () => { browser = await h.launch(); });
after(async () => { await browser.close(); });

function readRecording(file) {
    const meta = JSON.parse(fs.readFileSync(path.join(h.FILES, file.replace(/\.sigmf-data$/, '.sigmf-meta')), 'utf8'));
    const buf = fs.readFileSync(path.join(h.FILES, file));
    const iq = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    return { meta, iq, rate: meta.global['core:sample_rate'], samples: iq.length / 2 };
}

// Messages written to the page's log panel
const messages = page => page.evaluate(() => $('#openwebrx-messages').text());

test('IQ recording writes the SDR signal to a SigMF file', async () => {
    const page = await h.openReceiver(browser);
    await page.click('.openwebrx-iq-record-button');
    await page.waitForFunction(() => UI.iqRecording.recording, null, { timeout: 5000 });
    await page.waitForTimeout(2000);
    await page.click('.openwebrx-iq-record-button');
    await page.waitForFunction(() => /IQ recording saved to (IQ-\S+\.sigmf-data)/.test($('#openwebrx-messages').text()), null, { timeout: 10000 });
    const file = (await messages(page)).match(/IQ recording saved to (IQ-\S+\.sigmf-data)/)[1];
    const r = readRecording(file);
    assert.strictEqual(r.meta.global['core:datatype'], 'cf32_le');
    assert.strictEqual(r.rate, 250000);
    assert.strictEqual(r.meta.captures[0]['core:frequency'], h.CENTER);
    assert.ok(r.samples > 1.5 * r.rate && r.samples < 4 * r.rate, r.samples + ' samples');
    // The steady carrier is there at its programmed level (amplitude 0.05)
    assert.ok(Math.abs(h.toneLevel(r.iq, r.rate, 30000, r.rate) + 26) < 1, 'carrier level');
    assert.ok(h.toneLevel(r.iq, r.rate, 90000, r.rate) < -60, 'empty frequency is quiet');
    assert.deepStrictEqual(page.errors, []);
    await page.close();
});

test('SAVE writes the last seconds from the time-shift buffer', async () => {
    const page = await h.openReceiver(browser);
    await page.waitForTimeout(7000);          // fill the 5 second buffer
    await page.click('.openwebrx-iq-save-button');
    await page.waitForFunction(() => /Saved last \d+s of IQ to (IQ-\S+\.sigmf-data)/.test($('#openwebrx-messages').text()), null, { timeout: 10000 });
    const log = await messages(page);
    const file = log.match(/Saved last \d+s of IQ to (IQ-\S+\.sigmf-data)/)[1];
    const r = readRecording(file);
    assert.ok(Math.abs(r.samples / r.rate - 5) < 0.2, (r.samples / r.rate) + ' seconds saved');
    // 5 seconds always span an on/off switch of the 3 second burst
    const levels = [];
    for (let t = 0; t + 0.1 < r.samples / r.rate; t += 0.25) levels.push(h.toneLevel(r.iq, r.rate, -60000, Math.floor(t * r.rate)));
    assert.ok(levels.some(l => Math.abs(l + 14) < 1), 'burst on at -14 dBFS: ' + levels.map(Math.round));
    assert.ok(levels.some(l => l < -60), 'burst off: ' + levels.map(Math.round));
    assert.deepStrictEqual(page.errors, []);
    await page.close();
});
