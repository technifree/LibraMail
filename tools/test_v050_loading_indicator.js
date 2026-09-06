'use strict';
const fs = require('fs');
const assert = require('assert');

const app = fs.readFileSync('resources/js/app.js', 'utf8');
const html = fs.readFileSync('resources/index.html', 'utf8');
const css = fs.readFileSync('resources/css/app.css', 'utf8');

assert(app.includes('function prepareMailListLoading(token, shouldShow)'));
assert(app.includes('function finishMailListLoading(token)'));
assert(app.includes('prepareMailListLoading(token, !cached);'));
assert(app.includes('finishMailListLoading(token);'));
assert(html.includes('id="mail-list-loading"'));
assert(html.includes('fa-spinner fa-spin'));
assert(css.includes('.mail-list-stage'));
assert(css.includes('.mail-list-loading'));

console.log('[LibraMail] Test indicateur de chargement 0.5.0 : OK');
