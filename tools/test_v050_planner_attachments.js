'use strict';

const fs = require('fs');
const assert = require('assert');

const db = fs.readFileSync('engine/lib/db.js', 'utf8');
const backend = fs.readFileSync('engine/backend.js', 'utf8');
const dialog = fs.readFileSync('engine/lib/native_dialog.js', 'utf8');
const planner = fs.readFileSync('resources/js/planner.js', 'utf8');
const html = fs.readFileSync('resources/index.html', 'utf8');
const css = fs.readFileSync('resources/css/app.css', 'utf8');
const fr = JSON.parse(fs.readFileSync('resources/locales/fr.json', 'utf8'));
const en = JSON.parse(fs.readFileSync('resources/locales/en.json', 'utf8'));

assert(db.includes('CREATE TABLE IF NOT EXISTS calendar_event_attachments'));
assert(db.includes('REFERENCES calendar_events(id) ON DELETE CASCADE'));
assert(db.includes('function listCalendarAttachments'));
assert(db.includes('function listAllCalendarAttachments'));
assert(db.includes('function getCalendarAttachment'));
assert(db.includes('function addCalendarAttachments'));
assert(db.includes('function removeCalendarAttachment'));
assert(db.includes("DELETE FROM calendar_event_attachments WHERE event_id=?"));

assert(dialog.includes('async function showFilesDialog'));
assert(dialog.includes('showFilesDialog'));

for (const method of [
  "'calendar.attachments.selectPaths'",
  "'calendar.attachments.list'",
  "'calendar.attachments.addPaths'",
  "'calendar.attachments.open'",
  "'calendar.attachments.remove'",
]) assert(backend.includes(method), `RPC manquant: ${method}`);

assert(backend.includes("path.join(DATA, 'planner-attachments')"));
assert(backend.includes('cleanupOrphanCalendarAttachmentFiles'));
assert(backend.includes('ATTACHMENT_OPEN_BLOCKED'));
assert(backend.includes('fs.copyFileSync(source, target'));

for (const id of [
  'btn-planner-attachment-add',
  'planner-attachments-list',
  'planner-attachments-empty',
]) assert(html.includes(`id="${id}"`), `ID manquant: ${id}`);

assert(planner.includes('editorAttachments: []'));
assert(planner.includes('pendingAttachments: []'));
assert(planner.includes('function renderPlannerAttachments'));
assert(planner.includes('async function selectPlannerAttachments'));
assert(planner.includes("App.rpc('calendar.attachments.addPaths'"));
assert(planner.includes("App.rpc('calendar.attachments.open'"));
assert(planner.includes("App.rpc('calendar.attachments.remove'"));

assert(css.includes('LibraMail 0.5.0 - pièces jointes des rendez-vous'));
assert(css.includes('.planner-attachment-row'));

// LibraMail 0.5.0 - indicateur trombone dans les rendez-vous
assert(db.includes('attachmentCount: Math.max(0, Number(row.attachment_count) || 0)'));
assert((db.match(/calendar_event_attachments cea/g) || []).length === 2);
assert(planner.includes('function eventAttachmentIcon(event)'));
assert((planner.match(/eventAttachmentIcon\(event\)/g) || []).length >= 6);
assert(css.includes('LibraMail 0.5.0 - indicateur pièces jointes des rendez-vous'));
assert(css.includes('.planner-event-attachment-icon'));

for (const locale of [fr, en]) {
  for (const key of [
    'planner.attachments', 'planner.attachmentAdd', 'planner.attachmentSelect',
    'planner.attachmentEmpty', 'planner.attachmentPending',
    'planner.attachmentRemoveConfirm', 'planner.attachmentAddFailed',
  ]) assert(locale[key], `traduction absente: ${key}`);
}

console.log('[LibraMail] Test pièces jointes Planning 0.5.0 : OK');
