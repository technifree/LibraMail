'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'resources/js/app.js'), 'utf8');
const mail = fs.readFileSync(path.join(root, 'resources/js/maillist.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'resources/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'resources/css/app.css'), 'utf8');
const fr = JSON.parse(fs.readFileSync(path.join(root, 'resources/locales/fr.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'resources/locales/en.json'), 'utf8'));

// Étiquettes : patch immédiat des données de ligne.
assert(app.includes('// LibraMail 0.4.7 — étiquettes immédiates, suppression légère et lecteur modal.'));
assert(app.includes('function patchVisibleLabelSelection(items, label, applied)'));
assert(app.includes('applied: !applied'));
assert(app.includes('applied: !all'));

// Suppression : retrait local + compteurs différés, sans reconstruction bloquante.
assert(app.includes('scheduleSidebarCountsRefresh(160);'));
const deleteStart = app.indexOf('async function reconcileAfterMessageDeletion(items = [])');
const deleteEnd = app.indexOf('async function prefetchLocalFolderView', deleteStart);
assert(deleteStart >= 0 && deleteEnd > deleteStart);
const deletion = app.slice(deleteStart, deleteEnd);
assert(!deletion.includes('await refreshVisibleList'));
assert(!deletion.includes('await refreshSidebarCounts'));

// Double-clic : toute la zone non interactive de la ligne est prise en charge
// dès pointerdown. Le mécanisme survit donc au rerender provoqué par la preview.
assert(mail.includes('// LibraMail 0.4.7 — double-clic sur toute la ligne, détecté dès pointerdown.'));
assert(mail.includes("div.addEventListener('pointerdown', event => {"));
assert(mail.includes('const openAsDoubleClick = previousOpenPointerKey === key'));
assert(mail.includes('openPointerNow - previousOpenPointerAt <= 450'));
assert(mail.includes('this._suppressNextOpenClickKey = key'));
assert(mail.includes('this.callbacks.onOpenTab?.(row);'));

// Les boutons d'action restent exclus de l'ouverture modale.
assert(mail.includes("event.target.closest?.('button, input, select, textarea, a')"));

// La flèche de conversation conserve son blocage dblclick spécifique.
assert(mail.includes("threadToggle?.addEventListener('dblclick', event => {"));

// Modale et onglets existants.
assert(app.includes('async function openItemInModal(row)'));
assert(app.includes('async function closeReaderModal()'));
assert(app.includes("onOpenTab: row => openItemInModal(row).catch(error => {"));
assert(index.includes('id="reader-modal-backdrop"'));
assert(index.includes('id="btn-reader-modal-close"'));
assert(css.includes('/* LibraMail 0.4.7 — lecteur modal au double-clic */'));
assert(css.includes('#reader.reader-modal-open'));
assert(css.includes('#reader.reader-modal-open #reader-tab-preview'));
assert(app.includes('if (!next && readerModalOpen)'));
assert(app.includes('if (readerModalOpen) {\n      await closeReaderModal();\n      return;\n    }'));
assert(fr['tabs.closeWindow']);
assert(en['tabs.closeWindow']);

console.log('[LibraMail] Tests lecteur modal + étiquettes + suppression 0.4.7 : OK');
