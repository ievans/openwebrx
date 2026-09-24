// Spike scanner finds the fake SDR's switching signal and logs it
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

let browser;
before(async () => { browser = await h.launch(); });
after(async () => { await browser.close(); });

test('spike scanner tunes to the new signal and logs it', async () => {
    const page = await h.openReceiver(browser);
    await page.click('.openwebrx-spike-button');
    // The burst switches every 3s, so it appears as new within ~10s
    await page.waitForFunction(f => Math.abs(UI.getFrequency() - f) < 2000, h.BURST, { timeout: 20000 });
    const log = await page.evaluate(() => spikeScanner.log.map(e => e.freq));
    assert.ok(log.some(f => Math.abs(f - h.BURST) < 2000), 'burst logged: ' + log);
    assert.ok(!log.some(f => Math.abs(f - h.CARRIER) < 2000), 'steady carrier must not be logged: ' + log);
    // Activity log shows it and clicking the frequency tunes there in log-only mode
    await page.waitForSelector('.openwebrx-spike-log-row .spike-freq');
    await page.click('.openwebrx-spike-log-row >> nth=0 >> .spike-freq');
    assert.strictEqual(await page.evaluate(() => spikeScanner.autoTune), false);
    assert.deepStrictEqual(page.errors, []);
    await page.close();
});
