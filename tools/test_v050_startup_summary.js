"use strict";

const fs = require('fs');
const assert = require('assert');

const app = fs.readFileSync('resources/js/app.js', 'utf8');
const html = fs.readFileSync('resources/index.html', 'utf8');
const css = fs.readFileSync('resources/css/app.css', 'utf8');
const fr = JSON.parse(fs.readFileSync('resources/locales/fr.json', 'utf8'));
const en = JSON.parse(fs.readFileSync('resources/locales/en.json', 'utf8'));

for (const id of [
  'startup-summary-modal', 'startup-summary-date', 'startup-summary-unread-total',
  'startup-summary-accounts', 'startup-summary-events', 'startup-summary-sync-progress',
  'startup-summary-sync-accounts', 'startup-summary-dont-show', 'btn-enter-libramail',
  'btn-close-startup-summary', 'set-startup-summary',
]) assert(html.includes(`id="${id}"`), `ID manquant: ${id}`);

assert(html.indexOf('id="set-startup-summary"') < html.indexOf('data-settings-panel="mail"'));
assert(app.includes('function openStartupSummary()'));
assert(app.includes('function refreshStartupSummary()'));
assert(app.includes('function updateStartupSummarySync(event, data = {})'));
assert(app.includes("rpc('messages.list', { folderRole: 'inbox', spam: 0, limit: 1 })"));
assert(app.includes("rpc('calendar.list', { from: range.from, to: range.to, limit: 250 })"));
assert(app.includes("config.startupSummaryEnabled !== false"));
assert(app.includes("applySetting('startupSummaryEnabled', event.target.value === '1')"));
assert(app.includes("event === 'mail.new'"));
assert(app.includes('attachmentCount'));
assert(css.includes('LibraMail 0.5.0 - resume du jour au demarrage'));
assert(css.includes('.startup-summary-modal-box'));
assert(css.includes('.startup-summary-sync-list'));
assert(!html.includes('id="startup-summary-title"'));
assert(html.includes('id="startup-summary-heading-title"'));
assert(html.includes('class="startup-summary-windowbar"'));
assert(css.includes('LibraMail 0.5.0 - resume du jour style bureau'));

for (const locale of [fr, en]) {
  for (const key of [
    'startupSummary.title', 'startupSummary.mail', 'startupSummary.today',
    'startupSummary.sync', 'startupSummary.enterApp', 'startupSummary.dontShowAgain',
    'startupSummary.setting', 'startupSummary.settingHint',
  ]) assert(locale[key], `traduction absente: ${key}`);
}

assert(css.includes('LibraMail 0.5.0 - resume du jour style moderne equilibre'));

assert(css.includes('LibraMail 0.5.0 - resume du jour style macos'));

assert(css.includes('LibraMail 0.5.0 - resume du jour pastilles couleur'));

assert(app.includes('startup-summary-event-pin'));
assert(app.includes('fa-thumbtack'));
assert(css.includes('LibraMail 0.5.0 - resume du jour punaises sans hover'));

console.log('[LibraMail] Test Résumé du jour au démarrage 0.5.0 : OK');
