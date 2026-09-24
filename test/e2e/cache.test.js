// Pages must never run stale scripts or styles after an update
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const h = require('./helpers');

// node:http rather than fetch: the undici in Node 22.23.3 asserts when a
// server closes the connection after a large response, as this one does
function head(path, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get(h.URL + path, { headers }, r => {
            r.resume();
            r.on('end', () => resolve({ status: r.statusCode, headers: { get: k => r.headers[k.toLowerCase()] ?? null } }));
            r.on('error', reject);
        }).on('error', reject);
    });
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
