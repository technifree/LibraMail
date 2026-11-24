#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const helper = require('../resources/js/mail_provider_setup');
const email = 'demo@gmail.com';
const canonical = helper.profileFor('gmail', email);
assert(helper.isStandardGmail(email, 'imap', canonical));
assert(!helper.isStandardGmail(email, 'pop3', canonical));
for (const field of ['host', 'port', 'secure', 'user']) {
  const changed = structuredClone(canonical);
  changed.smtp[field] = { host:'other.example', port:587, secure:false, user:'different@example.org' }[field];
  assert(!helper.isStandardGmail(email, 'imap', changed), field);
}
assert.equal(helper.profileFor('microsoft', 'demo@example.org').smtp.host, 'smtp.office365.com');
assert.equal(helper.profileFor('microsoft', 'demo@live.fr').smtp.host, 'smtp-mail.outlook.com');
const html = read('resources/index.html');
const app = read('resources/js/app.js');
const modal = html.slice(html.indexOf('id="account-modal"'), html.indexOf('id="startup-summary-modal"'));
const ids = [...modal.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
assert.equal(new Set(ids).size, ids.length, 'IDs du formulaire uniques');
assert.match(modal, /<details id="acc-advanced"/);
assert(modal.indexOf('id="acc-guided-password-slot"') < modal.indexOf('<details id="acc-advanced"'));
for (const dict of [require('../resources/locales/fr.json'), require('../resources/locales/en.json')]) {
  for (const key of ['advancedSettings','gmailAppPasswordLabel','gmailAppPasswordPlaceholder','gmailAutoConfigured','microsoftConnectionPending','testAndAdd']) assert(dict['account.'+key], key);
}
class Element {
  constructor() {
    this.value = ''; this.dataset = {}; this.open = false; this.disabled = false; this.type = 'password';
    const classes = new Set();
    this.classList = { toggle: (key, value) => value ? classes.add(key) : classes.delete(key), contains: key => classes.has(key), add: key => classes.add(key), remove: key => classes.delete(key) };
  }
  appendChild(child) { child.parentElement = this; }
  focus() {}
}
const elements = Object.fromEntries(ids.map(id => [id,new Element()]));
const el = id => { assert(elements[id], id); return elements[id]; };
el('acc-imap-password-home').appendChild(el('acc-imap-password-field'));
const context = vm.createContext({ window:{ LibraMailProviderSetup:helper }, accountField:el, t:key=>key,
  document:{ querySelector:()=>null }, editingAccountId:null, updateAccountLogoPreview:()=>{}, setAccountStatus:()=>{} });
const start = app.indexOf('  function updateIncomingProtocolForm()');
const end = app.indexOf('  function openNewAccount()', start);
assert(start >= 0 && end > start);
vm.runInContext(app.slice(start,end)+'\nthis.api={resetAccountForm, updateAccountProviderAdvice, updateAccountSetupLayout, updateIncomingProtocolForm};',context);
const api = context.api;
api.resetAccountForm();
assert.equal(el('acc-advanced').open,false);
el('acc-email').value=email;
api.updateAccountProviderAdvice();
assert.equal(el('acc-imap-password-field').parentElement,el('acc-guided-password-slot'));
assert.equal(el('acc-advanced').open,false);
assert.equal(el('btn-save-account').disabled,false);
el('acc-imap-pass').value='abcd efgh ijkl mnop';
el('acc-advanced').open=true;
api.updateAccountSetupLayout();
assert.equal(el('acc-imap-pass').value,'abcd efgh ijkl mnop');
el('acc-smtp-host').value='custom.example';
api.updateAccountSetupLayout();
assert.equal(el('acc-imap-pass').value,'');
assert.equal(el('acc-imap-password-field').parentElement,el('acc-imap-password-home'));
assert(el('acc-advanced').open);
api.resetAccountForm();
el('acc-email').value=email; api.updateAccountProviderAdvice();
el('acc-imap-pass').value='secret'; el('acc-email').value='other@example.org'; api.updateAccountProviderAdvice();
assert.equal(el('acc-imap-pass').value,'');
assert.equal(el('acc-imap-host').value,'');
assert(el('acc-advanced').open);
api.resetAccountForm();
el('acc-email').value='demo@live.fr'; api.updateAccountProviderAdvice();
assert.equal(el('acc-advanced').open,false);
assert(el('btn-save-account').disabled);
assert(el('acc-advanced').classList.contains('account-microsoft-pending'));
el('acc-provider').value='other'; api.updateAccountProviderAdvice();
assert(!el('btn-save-account').disabled);
api.resetAccountForm();
el('acc-email').value=email; api.updateAccountProviderAdvice();
el('acc-receive-protocol').value='pop3'; api.updateIncomingProtocolForm(); api.updateAccountSetupLayout();
assert(el('acc-advanced').open);
assert(!el('account-pop3-section').classList.contains('hidden'));
assert(el('acc-guided-password-slot').classList.contains('hidden'));
api.resetAccountForm();
context.editingAccountId='existing';
el('acc-email').value=email; el('acc-imap-host').value='custom.example'; api.updateAccountProviderAdvice({autoFill:false});
assert.equal(el('acc-imap-host').value,'custom.example');
assert(el('acc-advanced').open);
assert(el('acc-guided-password-slot').classList.contains('hidden'));
assert.match(app,/payload\.imap\.pass = payload\.imap\.pass\.replace/);
console.log('[OK] LibraMail 0.7.0 : assistant de comptes, Gmail, Microsoft et préservation du mode avancé');
