'use strict';

const fs = require('fs');
const assert = require('assert');

const html = fs.readFileSync('resources/index.html', 'utf8');
const css = fs.readFileSync('resources/css/app.css', 'utf8');
const app = fs.readFileSync('resources/js/app.js', 'utf8');
const fr = JSON.parse(fs.readFileSync('resources/locales/fr.json', 'utf8'));
const en = JSON.parse(fs.readFileSync('resources/locales/en.json', 'utf8'));

for (const tab of ['general', 'mail', 'spam', 'planning', 'security', 'data']) {
  assert(html.includes(`data-settings-tab="${tab}"`), `onglet ${tab} absent`);
  assert(html.includes(`data-settings-panel="${tab}"`), `panneau ${tab} absent`);
}

assert.strictEqual((html.match(/data-settings-tab="/g) || []).length, 6);
const settingsHeaderPos = html.indexOf('<header><span data-i18n="settings"></span>');
const settingsTabsPos = html.indexOf('<div class="settings-tabs"', settingsHeaderPos);
const settingsBodyPos = html.indexOf('<div class="body settings-body">', settingsHeaderPos);
assert(settingsHeaderPos >= 0 && settingsTabsPos > settingsHeaderPos && settingsBodyPos > settingsTabsPos,
  'La barre des onglets doit rester hors de la zone de défilement des paramètres');
assert.strictEqual((html.match(/data-settings-panel="mail"/g) || []).length, 2);

assert(css.includes('LibraMail 0.5.0 - Parametres organises en onglets'));
assert(css.includes('.settings-tab-button.active'));
assert(css.includes('.settings-planning-placeholder'));

assert(app.includes("function activateSettingsTab(name = 'general')"));
assert(app.includes('function wireSettingsTabs()'));
assert(app.includes("activateSettingsTab(activateSettingsTab.current || 'general')"));
assert(app.includes('wireSettingsTabs();'));

const legacyIds = [
  'set-theme', 'set-locale', 'set-accent-preset', 'set-accent-color',
  'set-accent-hex', 'accent-preview-chip', 'accent-swatches', 'set-layout',
  'set-blockremote', 'set-conversations', 'set-group-date',
  'set-default-account', 'security-state-badge', 'btn-security-enable',
  'btn-security-change', 'btn-security-lock-settings', 'btn-security-disable',
  'security-settings-status', 'set-auto-read', 'set-read-delay',
  'set-signature-account', 'signature-editor', 'set-signature-enabled',
  'set-signature-format', 'set-signature-new', 'set-signature-replies',
  'set-signature-forwards', 'set-signature-separator',
  'set-signature-reply-position', 'set-signature-forward-position',
  'set-signature-content', 'settings-signature-preview',
  'signature-settings-status', 'btn-save-signature', 'sync-account-list',
  'spam-retention-account-list', 'spam-rule-action', 'spam-rule-kind',
  'spam-rule-value', 'btn-add-spam-rule', 'spam-rule-search',
  'spam-rule-total', 'spam-rules-list', 'spam-collected-count',
  'spam-senders-list', 'backup-password', 'backup-password-confirm',
  'btn-export-backup', 'btn-import-backup', 'eml-import-account',
  'eml-import-mode', 'eml-import-local-folder', 'btn-import-eml',
  'backup-progress', 'backup-progress-label', 'backup-progress-percent',
  'backup-progress-bar', 'backup-progress-detail', 'backup-operation-status',
];

for (const id of legacyIds) {
  const matches = html.match(new RegExp(`id="${id}"`, 'g')) || [];
  assert.strictEqual(matches.length, 1, `ID ${id}: ${matches.length} occurrence(s)`);
}

for (const locale of [fr, en]) {
  for (const key of [
    'settings.tab.general', 'settings.tab.mail', 'settings.tab.spam', 'settings.tab.planning',
    'settings.tab.security', 'settings.tab.data', 'settings.planningIntro',
  ]) {
    assert(locale[key], `traduction absente: ${key}`);
  }
}

console.log('[LibraMail] Test onglets Parametres 0.5.0 : OK');
