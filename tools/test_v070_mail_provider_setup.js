'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const provider = require('../resources/js/mail_provider_setup');

assert.equal(provider.recognizedProvider('  usEr@GMAIL.COM  '), 'gmail');
assert.equal(provider.recognizedProvider('username@gmail.com.evil.invalid'), '');
assert.equal(provider.recognizedProvider('a@googlemail.com'), 'gmail');
for (const domain of ['hotmail.com', 'hotmail.fr', 'outlook.com', 'outlook.fr', 'live.com', 'live.fr']) {
  assert.equal(provider.recognizedProvider(`demo@${domain}`), 'microsoft');
}
assert.equal(provider.recognizedProvider('demo@company.example'), '');
assert.equal(provider.resolvedProvider('demo@company.example', 'microsoft'), 'microsoft');
assert.equal(provider.resolvedProvider('demo@gmail.com', 'other'), 'other');
const gmail = provider.profileFor('gmail', 'demo@gmail.com');
assert.deepEqual(gmail.imap, { host: 'imap.gmail.com', port: 993, secure: true, user: 'demo@gmail.com' });
assert.deepEqual(gmail.smtp, { host: 'smtp.gmail.com', port: 465, secure: true, user: 'demo@gmail.com' });
assert.equal(gmail.authentication, 'app-password');
const microsoft = provider.profileFor('microsoft', 'demo@outlook.com');
assert.equal(microsoft.authentication, 'oauth2-required');
assert.equal(microsoft.imap.host, 'outlook.office365.com');
assert.equal(microsoft.smtp.port, 587);
assert.equal(microsoft.smtp.secure, false);
assert.equal(provider.profileFor('other', 'demo@example.com'), null);
assert.equal(provider.mayReplace('host', 'smtp.gmail.com'), true);
assert.equal(provider.mayReplace('host', 'mail.mycompany.example'), false);
assert.equal(provider.mayReplace('port', '465'), true);
assert.equal(provider.mayReplace('port', '2525'), false);

const backend = fs.readFileSync(path.join(root, 'engine', 'backend.js'), 'utf8');
assert.match(backend, /if \(providerKeyForAccount\(input\) === 'outlook'\)/);
const html = fs.readFileSync(path.join(root, 'resources', 'index.html'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'resources', 'js', 'app.js'), 'utf8');
const planner = fs.readFileSync(path.join(root, 'resources', 'js', 'planner.js'), 'utf8');
const fr = require('../resources/locales/fr.json');
const en = require('../resources/locales/en.json');
for (const id of ['acc-provider', 'acc-provider-advice', 'acc-gmail-password-link']) {
  assert.match(html, new RegExp(`id="${id}"`));
}
assert.ok(html.indexOf('js/mail_provider_setup.js') < html.indexOf('js/app.js'));
assert.match(ui, /account\.microsoftOAuthRequiredSave/);
assert.match(ui, /updateAccountProviderAdvice/);
assert.match(planner, /googleTargetId/);
for (const dict of [fr, en]) {
  for (const key of [
    'account.providerSelection', 'account.gmailAppPasswordGuide',
    'account.microsoftOAuthNotReady', 'planner.subscriptionHelp',
    'planner.googleWriteHelp',
  ]) assert.ok(dict[key]);
  assert.match(dict['planner.subscriptionHelp'], /(?:lecture seule|read.only)/i);
}
console.log('✓ LibraMail 0.7.0 preparation: assistant Gmail, garde-fou Microsoft, calendrier ICS en lecture seule');
