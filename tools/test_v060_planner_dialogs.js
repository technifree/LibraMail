#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const planner = fs.readFileSync(path.join(__dirname, '../resources/js/planner.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../resources/css/app.css'), 'utf8');
const fr = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/locales/fr.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/locales/en.json'), 'utf8'));

assert(!planner.includes('window.confirm('), 'le Planning ne doit plus utiliser window.confirm');
assert(!planner.includes('window.alert('), 'le Planning ne doit plus utiliser window.alert');
assert(planner.includes('async function plannerConfirm('));
assert(planner.includes("title: t('planner.deleteTitle')"));
assert(planner.includes("title: t('planner.googleDisconnectTitle')"));
assert(planner.includes("title: t('planner.attachmentRemoveTitle')"));
assert(planner.includes("title: t('planner.removeSubscriptionTitle'"));
assert(planner.includes("`${recurringMessage} · ${t('planner.importTruncated')}`"));

assert(css.includes('.planner-form-error:not(:empty)'));
assert(css.includes('flex:none; min-height:0;'));
assert(css.includes('.planner-editor-actions {'));
assert(css.includes('flex:none; display:grid;'));

for (const locale of [fr, en]) {
  for (const key of [
    'planner.dialogUnavailable',
    'planner.attachmentRemoveTitle',
    'planner.attachmentRemoveAction',
    'planner.deleteTitle',
    'planner.deleteNote',
    'planner.googleDeleteNote',
    'planner.googleDisconnectTitle',
    'planner.googleDisconnectNote',
    'planner.googleReadOnlyEvent',
  ]) {
    assert(locale[key], `traduction manquante : ${key}`);
  }
}

assert(!fr['planner.googleReadOnlyEvent'].includes('Android'));
assert(!fr['planner.googleReadOnlyEvent'].includes('cette version de LibraMail'));

console.log('[LibraMail] Test dialogues Planning 0.6.0 : OK');
