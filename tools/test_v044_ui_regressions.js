'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(
  path.join(__dirname, '..', 'resources', 'css', 'app.css'),
  'utf8'
);

assert(
  css.includes('--planner-main-width: clamp(170px, 20vw, 290px);'),
  'Le volet Planning doit être plafonné par le viewport'
);
assert(
  css.includes('clamp(150px, var(--sidebar-width), 24vw)'),
  'La sidebar doit pouvoir se contracter sans modifier sa préférence'
);
assert(
  css.includes('clamp(190px, var(--list-width), 32vw)'),
  'La liste doit pouvoir se contracter sans modifier sa préférence'
);
assert(
  css.includes('minmax(100px, 1fr) var(--planner-main-current-width);'),
  'Le lecteur doit pouvoir céder de la largeur au Planning'
);

const start = css.indexOf('.planner-main-event-main {');
const end = css.indexOf('.planner-main-date-separator', start);
assert(start >= 0 && end > start, 'Bloc texte Planning introuvable');
const block = css.slice(start, end);
assert(
  block.includes('white-space:normal;'),
  'Les titres du Planning doivent pouvoir revenir à la ligne'
);

console.log('[LibraMail] Tests UI 0.4.4 : OK (grille responsive + texte Planning)');
