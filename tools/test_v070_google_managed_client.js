'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(root, 'engine/backend.js'), 'utf8');
const planner = fs.readFileSync(path.join(root, 'resources/js/planner.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'resources/index.html'), 'utf8');
assert.match(backend, /LIBRAMAIL_GOOGLE_CALENDAR_CLIENT_ID/);
assert.match(backend, /'calendar\.google\.oauth\.config'/);
assert.match(planner, /App\.rpc\('calendar\.google\.oauth\.config'\)/);
assert.doesNotMatch(planner, /if \(!clientSecret\)\s*\{\s*googleStatus\(t\('planner\.googleClientSecretRequired'\)/);
assert.match(html, /id="planner-google-managed-help"/);
for (const locale of ['fr', 'en']) {
  const messages = JSON.parse(fs.readFileSync(path.join(root, `resources/locales/${locale}.json`), 'utf8'));
  assert.ok(messages['planner.googleManagedClient']);
  assert.ok(messages['planner.googleWriteHelp']);
}
console.log('✓ LibraMail Google Calendar: client ID public facultatif et secret non obligatoire');
