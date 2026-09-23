// Loads browser source files from htdocs/ into a sandbox with the given
// globals, so that they can be unit tested with Node's built-in test runner.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

module.exports = function load(files, globals = {}) {
    const context = vm.createContext(Object.assign({ console, Math, Date, Float32Array, Int16Array, Uint8Array, Array, Object, JSON, Number }, globals));
    for (const f of files) {
        const code = fs.readFileSync(path.join(__dirname, '..', '..', 'htdocs', f), 'utf8');
        vm.runInContext(code, context, { filename: f });
    }
    return context;
};
