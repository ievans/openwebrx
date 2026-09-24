// Receiver panel layout and status bars
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

let browser;
before(async () => { browser = await h.launch(); });
after(async () => { await browser.close(); });

test('there is no IQ Recording section or IQ record/save controls, panel stays above the frequency scale', async () => {
    const page = await h.openReceiver(browser);
    await page.setViewportSize({ width: 1280, height: 560 });
    const r = await page.evaluate(() => {
        for (const s of ['modes', 'controls', 'scan', 'settings']) {
            UI.toggleSection(document.getElementById('openwebrx-section-' + s), true);
        }
        const panel = document.getElementById('openwebrx-panel-receiver').getBoundingClientRect();
        const scale = document.getElementById('openwebrx-frequency-container').getBoundingClientRect();
        // A point of the panel lying over the frequency scale
        const y = Math.max(panel.top, scale.top) + 5;
        const hit = document.elementFromPoint(panel.left + panel.width / 2, y);
        return {
            sections: $('.openwebrx-section-divider').map((i, e) => e.textContent.trim().replace(/^\W+/, '')).get(),
            iqControls: $('.openwebrx-iq-record-button, .openwebrx-iq-save-button, #openwebrx-iq-tools').length,
            overlapsScale: panel.top < scale.bottom,
            onTop: !!hit && !!hit.closest('#openwebrx-panel-receiver'),
        };
    });
    assert.ok(r.sections.includes('Scan') && !r.sections.includes('IQ Recording'), r.sections.join(','));
    assert.strictEqual(r.iqControls, 0, 'IQ recording was removed');
    assert.ok(r.overlapsScale, 'test needs the panel to reach up to the scale');
    assert.ok(r.onTop, 'receiver panel must be drawn above the frequency scale');
    assert.deepStrictEqual(page.errors, []);
    await page.close();
});

test('spike scanner Tune is on by default, even after turning it off', async () => {
    const page = await h.openReceiver(browser);
    assert.strictEqual(await page.isChecked('#openwebrx-spike-autotune'), true);
    await page.uncheck('#openwebrx-spike-autotune');
    await page.reload();
    await page.waitForFunction(() => typeof spikeScanner !== 'undefined' && spikeScanner, null, { timeout: 30000 });
    await page.waitForTimeout(1000);
    assert.strictEqual(await page.isChecked('#openwebrx-spike-autotune'), true);
    assert.strictEqual(await page.evaluate(() => spikeScanner.autoTune), true);
    await page.close();
});

test('status shows IQ buffer fill (the buffer is enabled for this server) and server memory', async () => {
    const page = await h.openReceiver(browser);
    assert.ok(await page.isVisible('#openwebrx-bar-iq-buffer'), 'IQ buffer bar shown when the buffer is enabled');
    await page.waitForFunction(() => /IQ buffer \[\d+% \d+\/12s\]/.test($('#openwebrx-bar-iq-buffer').text()), null, { timeout: 10000 });
    const title = await page.getAttribute('#openwebrx-bar-iq-buffer', 'title');
    assert.match(title, /of 12 seconds at 2\.4MS\/s, \d+MB of 220MB system memory/);
    await page.waitForFunction(() => /Server Memory \[\d+% [\d.]+\/[\d.]+GB\]/.test($('#openwebrx-bar-server-memory').text()), null, { timeout: 10000 });
    assert.deepStrictEqual(page.errors, []);
    await page.close();
});
