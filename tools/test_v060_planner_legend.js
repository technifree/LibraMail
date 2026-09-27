'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const html = read('resources/index.html');
const css = read('resources/css/app.css');
const planner = read('resources/js/planner.js');
const fr = JSON.parse(read('resources/locales/fr.json'));
const en = JSON.parse(read('resources/locales/en.json'));

assert(html.includes('id="planner-category-legend"'), 'conteneur de légende absent');
assert(html.includes('data-i18n-aria-label="planner.legend"'), 'libellé accessible de légende absent');
assert(css.includes('.planner-category-legend {'), 'styles de la légende absents');
assert(css.includes('.planner-category-legend-dot {'), 'pastille de couleur absente');
assert(planner.includes('function renderCategoryLegend()'), 'rendu dynamique de la légende absent');
assert(planner.includes('state.categories.filter(category => category.active)'), 'la légende doit ignorer les catégories inactives');
assert(planner.includes('style="--category-color:${esc(color)}"'), 'la légende n’utilise pas la couleur configurée');
assert(planner.includes('renderCategoryLegend();'), 'la légende n’est pas mise à jour après chargement des catégories');
assert(planner.includes("event === 'calendar.categories.changed'"), 'événement de changement des catégories absent');
assert.strictEqual(fr['planner.legend'], 'Légende');
assert.strictEqual(en['planner.legend'], 'Legend');

console.log('[LibraMail] Test légende catégories Planning 0.6.0 : OK');
