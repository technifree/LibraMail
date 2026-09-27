'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const app = read('resources/js/app.js');
const html = read('resources/index.html');
const css = read('resources/css/app.css');
const fr = JSON.parse(read('resources/locales/fr.json'));
const en = JSON.parse(read('resources/locales/en.json'));

assert(html.includes('id="list-refreshing"'), 'témoin discret d’actualisation absent');
assert(css.includes('.list-refreshing.hidden { display: none; }'), 'style du témoin discret absent');
assert.strictEqual(fr['list.refreshing'], 'Actualisation…');
assert.strictEqual(en['list.refreshing'], 'Refreshing…');

assert(app.includes("let renderedListCacheKey = '';"), 'clé de la vue affichée absente');
assert(app.includes('const sameRenderedView = renderedListCacheKey === cacheKey;'), 'détection de vue affichée absente');
assert(app.includes('const hasVisibleRows = sameRenderedView'), 'détection des lignes visibles absente');
assert(app.includes('const backgroundRefresh = Boolean(cached || hasVisibleRows);'), 'mode d’actualisation arrière-plan absent');
assert(app.includes('prepareMailListLoading(token, !backgroundRefresh);'), 'grand chargement non limité au premier affichage');
assert(app.includes('prepareMailListRefreshing(token, backgroundRefresh);'), 'témoin discret non activé en arrière-plan');
assert(app.includes('} else if (!hasVisibleRows) {'), 'la liste visible peut encore être vidée pendant une actualisation');
assert(app.includes('if (token === listRefreshToken && !cached && !hasVisibleRows) {'),
  'une erreur d’actualisation peut encore remplacer le sous-titre d’une liste visible');
assert(app.includes('finishMailListRefreshing(token);'), 'témoin discret non nettoyé');

const refreshStart = app.indexOf('async function refresh({');
const refreshEnd = app.indexOf('\n\n  function setCount(', refreshStart);
assert(refreshStart >= 0 && refreshEnd > refreshStart, 'fonction refresh introuvable');
const refreshBody = app.slice(refreshStart, refreshEnd);
const clearIndex = refreshBody.indexOf('list.setData([], mailListOptions(false));');
const guardIndex = refreshBody.indexOf('} else if (!hasVisibleRows) {');
assert(clearIndex > guardIndex && guardIndex >= 0, 'vidage de liste non protégé par hasVisibleRows');

console.log('[LibraMail] Test rafraîchissement non bloquant de la liste 0.6.0 : OK');
