#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../resources/index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../resources/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../resources/css/app.css'), 'utf8');
const fr = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/locales/fr.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/locales/en.json'), 'utf8'));

const passwordIds = [...html.matchAll(/<input\b[^>]*\bid="([^"]+)"[^>]*\btype="password"[^>]*>/g)]
  .map(match => match[1]);

assert(passwordIds.length >= 10, `au moins 10 champs mot de passe attendus, trouvé ${passwordIds.length}`);

for (const id of passwordIds) {
  const toggle = `data-password-toggle="${id}"`;
  assert(html.includes(toggle), `révélateur absent pour ${id}`);
}

for (const id of [
  'acc-imap-pass',
  'acc-pop3-pass',
  'acc-smtp-pass',
  'backup-password',
  'backup-password-confirm',
  'planner-google-client-secret',
]) {
  assert(passwordIds.includes(id), `champ attendu absent : ${id}`);
  assert(html.includes(`data-password-toggle="${id}"`), `révélateur attendu absent : ${id}`);
}

const toggleButtons = [...html.matchAll(/<button\b[^>]*class="security-password-toggle"[^>]*>/g)]
  .map(match => match[0]);
assert.strictEqual(
  toggleButtons.length,
  passwordIds.length,
  'chaque champ mot de passe doit avoir exactement un révélateur',
);
for (const button of toggleButtons) {
  assert(/\btype="button"/.test(button), 'un révélateur ne doit jamais soumettre le formulaire');
  assert(/\bdata-i18n-title="security\.showPassword"/.test(button));
}

assert(app.includes("document.querySelectorAll('[data-password-toggle]')"));
assert(app.includes("input.type = visible ? 'password' : 'text'"));
assert(app.includes("'fa-solid fa-eye-slash'"));
assert(app.includes("'security.showPassword'"));
assert(app.includes("'security.hidePassword'"));

assert(css.includes('.security-password-input-wrap'));
assert(css.includes('.security-password-toggle'));
assert(css.includes('padding-right: 38px'));

for (const locale of [fr, en]) {
  assert(locale['security.showPassword']);
  assert(locale['security.hidePassword']);
}

console.log('[LibraMail] Test révélateurs de mots de passe 0.6.0 : OK');
