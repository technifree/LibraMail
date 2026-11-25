'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const helper = require('../resources/js/mail_provider_setup');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const backend = read('engine/backend.js');
const app = read('resources/js/app.js');
const email = 'demo@gmail.com';
const profile = helper.profileFor('gmail', email);
const password = 'abcd efgh ijkl mnop';
assert(helper.validAppPassword(password));
assert(helper.validAppPassword('abcdefghijklmnop'));
for (const invalid of ['', 'short', 'abcdefghijklmnopq', 'abcdefghijklmnoé', 'abcdefghijklmno\x00']) assert(!helper.validAppPassword(invalid));
assert.equal(helper.gmailSetupError('GMAIL_SETUP_SMTP_UNKNOWN'), null);
assert.equal(helper.gmailSetupError('GMAIL_SETUP_SMTP_AUTH extra'), null);

const fn = backend.slice(backend.indexOf('function accountConnectionError('), backend.indexOf('async function syncRole('));
const classify = vm.runInNewContext(fn + '\naccountConnectionError');
const cases = [
  [{responseCode:534,message:'5.7.9 Application-specific password required'},'APP_PASSWORD'],
  [{code:'EAUTH',responseCode:535},'AUTH'],
  [{authenticationFailed:true},'AUTH'],
  [{code:'CERT_HAS_EXPIRED'},'TLS'],
  [{code:'ETIMEDOUT'},'TIMEOUT'],
  [{code:'ENOTFOUND'},'DNS'],
  [{code:'ECONNREFUSED'},'NETWORK'],
  [{responseCode:421},'TEMPORARY'],
  [{message:'other error'},'SERVER'],
];
for (const kind of ['smtp','imap','pop3']) {
  const account = {email,[kind]:{host:`${kind}.gmail.com`,pass:'SECRET'}};
  for (const [error, reason] of cases) {
    const message = classify(kind.toUpperCase(),account,{...error,message:(error.message || '')+' SECRET'}).message;
    assert.equal(message,`GMAIL_SETUP_${kind.toUpperCase()}_${reason}`);
    const diagnosis = helper.gmailSetupError(message);
    assert.equal(diagnosis.protocol,kind.toUpperCase());
    for (const lang of ['fr','en']) {
      const dict = require(`../resources/locales/${lang}.json`);
      assert(dict[diagnosis.key].includes('{protocol}'));
      assert(dict['account.gmailPasswordFormat']);
    }
  }
}
assert.equal(classify('SMTP',{smtp:{host:'smtp.gmail.com.example'}},{message:'original'}).message,'SMTP : original');
assert.equal(classify('IMAP',{email,imap:{host:'other.example'}},{message:'original'}).message,'IMAP : original');

// Execute actual backend add/update handlers with mock transport and persistence.
const section = backend.slice(backend.indexOf("  'accounts.add': async input => {"), backend.indexOf("  'accounts.remove': async"));
const current = {...profile,id:'existing',email,receiveProtocol:'imap',imap:{...profile.imap,pass:'old'},smtp:{...profile.smtp,pass:'old'}};
let fail = '', writes = 0, calls = [];
const verify = kind => async () => { calls.push(kind); if (fail===kind) throw {code:'EAUTH',message:'secret response'}; return {inbox:'INBOX',sent:'[Gmail]/Sent Mail'}; };
const context = vm.createContext({
  validateAccountInput(){}, providerKeyForAccount:()=> 'gmail', crypto:{randomUUID:()=> 'new'},
  normalizeAccount:x=>x, normalizeLogoData:()=>'', smtp:{verify:verify('smtp')}, pop3:{verify:verify('pop3')},
  imap:{resolveFolderMap:verify('imap'),stopWatch(){}}, credentialStore:{storeIncoming(){writes++;}},
  accounts:[current],config:{defaultAccountId:'existing'},saveJson(){},saveAccounts(){writes++;},
  startWatch(){},scheduleAccount(){},publicAccount:x=>x,getAccount:()=>current,activeSyncs:new Set(),syncTimers:new Map(),
  cleanupExpiredSpamForAccount:async()=>{}, accountConnectionError:classify,
});
const handlers=vm.runInContext('({'+section+'})',context);
const input={...profile,email,receiveProtocol:'imap',imap:{...profile.imap,pass:'abcdefghijklmnop'},smtp:{...profile.smtp,pass:''}};
(async()=>{
  for (const method of ['accounts.add','accounts.update']) {
    for (const kind of ['smtp','imap']) {
      fail=kind; calls=[]; writes=0;
      await assert.rejects(handlers[method]({...input,id:'existing'}),new RegExp(`GMAIL_SETUP_${kind.toUpperCase()}_AUTH`));
      assert.equal(writes,0,'no persistence on failed authentication');
      assert.equal(context.accounts[0],current);
      assert.deepEqual(calls,kind==='smtp'?['smtp']:['smtp','imap']);
    }
  }
  fail=''; calls=[]; writes=0;
  const added=await handlers['accounts.add'](input);
  assert.deepEqual(calls,['smtp','imap']); assert.equal(writes,2);
  assert.equal(added.folderMap.inbox,'INBOX');
  assert.equal(added.smtp.pass,input.imap.pass);

  // Run actual GUI save handler; no RPC for malformed guided password.
  const save=app.slice(app.indexOf('  async function saveAccount()'),app.indexOf('  async function deleteEditedAccount()'));
  let rpcCalls=0, status='';
  const payload=structuredClone(input);
  const ui=vm.createContext({accountSaving:false,accountEditorLoading:false,editingAccountId:null,guidedPasswordIdentity:email,
    accountField:()=>({disabled:false}),selectedAccountProvider:()=> 'gmail',accountPayload:()=>payload,
    t:(key,vars)=>vars?`${key}:${vars.protocol}`:key,setAccountStatus:msg=>{status=msg;},window:{LibraMailProviderSetup:helper},
    rpc:async()=>{rpcCalls++; throw new Error('GMAIL_SETUP_SMTP_APP_PASSWORD');},
  });
  const run=vm.runInContext(save+'\nsaveAccount',ui);
  payload.imap.pass='wrong'; await run(); assert.equal(rpcCalls,0); assert(status.includes('account.gmailPasswordFormat'));
  payload.imap.pass=password; await run(); assert.equal(rpcCalls,1); assert.equal(payload.imap.pass,'abcdefghijklmnop'); assert(status.includes('account.gmailError.APP_PASSWORD:SMTP'));
  ui.editingAccountId='existing'; payload.imap.pass=''; await run(); assert.equal(rpcCalls,2,'existing accounts are not subject to guided validation');
  console.log('[OK] LibraMail 0.7.0 : assistance Gmail, diagnostics FR/EN et aucune persistance avant validation IMAP/SMTP');
})().catch(error=>{console.error(error);process.exitCode=1;});
