// Pages must never run stale scripts or styles after an update
const { test } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

async function head(path, headers = {}) {
    const r = await fetch(h.URL + path, { headers });
    await r.arrayBuffer();
    return r;
}

test('scripts and styles are revalidated on every load', async () => {
    for (const path of ['/compiled/receiver.js', '/static/css/openwebrx.css']) {
        const r = await head(path);
        assert.strictEqual(r.headers.get('cache-control'), 'max-age=0', path);
        const again = await head(path, { 'If-Modified-Since': r.headers.get('last-modified') });
        assert.strictEqual(again.status, 304, path + ' unchanged must be 304');
    }
    assert.strictEqual((await head('/static/gfx/openwebrx-avatar.png')).headers.get('cache-control'), 'max-age=3600');
});
