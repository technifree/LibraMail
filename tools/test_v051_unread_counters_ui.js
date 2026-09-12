'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

const maillist = read('resources/js/maillist.js');
const css = read('resources/css/app.css');
const fr = JSON.parse(read('resources/locales/fr.json'));
const en = JSON.parse(read('resources/locales/en.json'));

assert(
  maillist.includes("const totalLabel = window.t?.('group.total') || 'Total';"),
  'le compteur total doit disposer d’un libellé explicite'
);
assert(
  maillist.includes("const unreadLabel = window.t?.('stats.unread') || 'Non lus';"),
  'le compteur non lu doit réutiliser le libellé traduit existant'
);
assert(
  maillist.includes('fa-regular fa-envelope mail-group-count-icon'),
  'le total doit être identifiable par une enveloppe'
);
assert(
  maillist.includes('mail-group-unread-dot'),
  'le nombre de non-lus doit être identifiable par un point bleu'
);
assert(
  maillist.includes('title="${this.escapeAttr(totalTitle)}"'),
  'le total doit avoir une infobulle explicite'
);
assert(
  maillist.includes('title="${this.escapeAttr(unreadTitle)}"'),
  'le compteur de non-lus doit avoir une infobulle explicite'
);
assert(
  maillist.includes('${item.unread ? `<span class="mail-group-unread"'),
  'le badge non lu ne doit apparaître que si le groupe contient des non-lus'
);

assert(css.includes('.mail-group-count-icon'), 'le style de l’icône du total doit être défini');
assert(css.includes('.mail-group-unread-dot'), 'le style du point non lu doit être défini');
assert(
  css.includes('border: 1px solid var(--border-soft);'),
  'le compteur total doit rester visuellement neutre'
);
assert(
  css.includes('background: var(--accent);'),
  'le point non lu doit utiliser la couleur d’accent'
);

assert.strictEqual(fr['group.total'], 'Total');
assert.strictEqual(en['group.total'], 'Total');
assert.strictEqual(fr['stats.unread'], 'Non lus');
assert.strictEqual(en['stats.unread'], 'Unread');

console.log('[LibraMail] Test lisibilité compteurs lu/non lu 0.5.1 : OK');
