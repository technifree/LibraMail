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

assert(app.includes('// LibraMail 0.4.7 — étiquettes immédiates, suppression légère et lecteur modal.'));
assert(app.includes('function patchVisibleLabelSelection(items, label, applied)'));
assert(app.includes('applied: !applied'));
assert(app.includes('applied: !all'));
assert(app.includes('scheduleSidebarCountsRefresh(160);'));

const deleteStart = app.indexOf('async function reconcileAfterMessageDeletion(items = [])');
const deleteEnd = app.indexOf('async function prefetchLocalFolderView', deleteStart);
const deletion = app.slice(deleteStart, deleteEnd);
assert(!deletion.includes('await refreshVisibleList'));
assert(!deletion.includes('await refreshSidebarCounts'));

assert(mail.includes("div.addEventListener('dblclick', event => {"));
assert(mail.includes('this.callbacks.onOpenTab?.(row);'));

assert(app.includes('async function openItemInModal(row)'));
assert(app.includes('async function closeReaderModal()'));
assert(app.includes("onOpenTab: row => openItemInModal(row).catch(error => {"));

assert(index.includes('id="reader-modal-backdrop"'));
assert(index.includes('id="btn-reader-modal-close"'));
assert(css.includes('/* LibraMail 0.4.7 — lecteur modal au double-clic */'));
assert(css.includes('#reader.reader-modal-open'));

assert(fr['tabs.closeWindow']);
assert(en['tabs.closeWindow']);

console.log('[LibraMail] Tests lecteur modal + étiquettes + suppression 0.4.7 : OK');
