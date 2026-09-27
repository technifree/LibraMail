'use strict';
const fs = require('fs');
const assert = require('assert');

const app = fs.readFileSync('resources/js/app.js', 'utf8');
const html = fs.readFileSync('resources/index.html', 'utf8');
const css = fs.readFileSync('resources/css/app.css', 'utf8');

assert(app.includes('function prepareMailListLoading(token, shouldShow)'));
assert(app.includes('function finishMailListLoading(token)'));
// Depuis la 0.6.0, le grand indicateur n'est affiché que si aucune liste\n// n'est déjà disponible à l'écran. Le test 0.6.0 vérifie le détail de\n// cette politique ; ce test historique vérifie que le mécanisme existe.\nassert(app.includes('prepareMailListLoading(token, !backgroundRefresh);'));\nassert(app.includes('finishMailListLoading(token);'));
assert(html.includes('id="mail-list-loading"'));
assert(html.includes('fa-spinner fa-spin'));
assert(css.includes('.mail-list-stage'));
assert(css.includes('.mail-list-loading'));

console.log('[LibraMail] Test indicateur de chargement 0.5.0 : OK');
