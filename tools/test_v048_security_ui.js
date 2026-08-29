'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const backend = fs.readFileSync(path.join(root, 'engine/backend.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'resources/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'resources/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'resources/css/app.css'), 'utf8');
const fr = JSON.parse(fs.readFileSync(path.join(root, 'resources/locales/fr.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'resources/locales/en.json'), 'utf8'));

for (const id of ['security-lock-screen','security-unlock-form','security-unlock-password','btn-security-unlock','btn-security-unlock-quit','btn-lock-app','security-state-badge','btn-security-enable','btn-security-change','btn-security-disable','btn-security-lock-settings','security-password-modal','security-password-form']) {
  assert(html.includes(`id="${id}"`), `HTML manquant : ${id}`);
}
assert(css.includes('/* LibraMail 0.4.8 — interface du mot de passe principal. */'));
assert(css.includes('.security-lock-screen'));
assert(css.includes('.security-settings-card'));
assert(backend.includes("'security.status': async () => {"));
assert(backend.includes("locale: ['fr', 'en'].includes"));
assert(backend.includes("theme: ['dark', 'light'].includes"));
assert(app.includes("const security = await rpc('security.status');"));
assert(app.includes('showSecurityLockScreen();'));
assert(app.includes("await rpc('security.unlock', { password })"));
assert(app.includes("await rpc('security.lock')"));
assert(app.includes('window.location.reload();'));
assert(app.includes("await rpc('security.enable', { password: newPassword })"));
assert(app.includes("await rpc('security.changePassword', { currentPassword, newPassword })"));
assert(app.includes("await rpc('security.disable', { password: currentPassword })"));
const securityPos = app.indexOf("const security = await rpc('security.status');");
const configPos = app.indexOf("const state = await rpc('config.get');", securityPos);
assert(securityPos >= 0 && configPos > securityPos);
for (const key of ['security.sectionTitle','security.masterPassword','security.enable','security.change','security.disable','security.lock','security.unlock','security.lockedTitle','security.recoveryWarning','security.incorrectPassword']) {
  assert(fr[key], `Traduction FR manquante : ${key}`);
  assert(en[key], `Traduction EN manquante : ${key}`);
}
console.log('[LibraMail] Tests interface sécurité 0.4.8 : OK');
