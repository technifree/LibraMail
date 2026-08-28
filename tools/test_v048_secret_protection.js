'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const masterPassword = require('../engine/lib/master_password');
const credentialStore = require('../engine/lib/credential_store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-secret-protection-'));
const data = path.join(root, 'data');

try {
  const password1 = 'Principal-048-Securise!';
  const password2 = 'Principal-048-Nouveau!';
  const context = credentialStore.accountSecretContext('account-test', 'imap');
  const otherContext = credentialStore.accountSecretContext('account-test', 'smtp');
  const secret = 'mot-de-passe-imap';

  masterPassword.init(data);
  assert.strictEqual(credentialStore.encodeForStorage(secret, context), secret);

  masterPassword.enable(password1);
  assert.strictEqual(masterPassword.verify(password1), true);
  assert.throws(() => masterPassword.verify('Mauvais-048!'), /incorrect/i);

  const protectedValue = credentialStore.encodeForStorage(secret, context);
  assert(protectedValue.startsWith('vault1:'));
  assert(!protectedValue.includes(secret));
  assert.strictEqual(credentialStore.decodeForStorage(protectedValue, context), secret);
  assert.throws(
    () => credentialStore.decodeForStorage(protectedValue, otherContext),
    /contexte incorrect|illisible/i,
  );

  // Le changement du mot de passe principal ne ré-encrypte pas les secrets :
  // la clé de coffre reste identique, seule son enveloppe change.
  masterPassword.changePassword(password1, password2);
  assert.strictEqual(credentialStore.decodeForStorage(protectedValue, context), secret);
  assert.throws(() => masterPassword.verify(password1), /incorrect/i);
  assert.strictEqual(masterPassword.verify(password2), true);

  const securityFile = path.join(data, 'security.json');
  assert(fs.existsSync(securityFile));
  masterPassword.disable(password2);
  assert.strictEqual(masterPassword.status().enabled, false);
  assert.strictEqual(fs.existsSync(securityFile), false);
  assert.strictEqual(credentialStore.encodeForStorage(secret, context), secret);

  const backend = fs.readFileSync(path.join(__dirname, '../engine/backend.js'), 'utf8');
  const credentialSource = fs.readFileSync(path.join(__dirname, '../engine/lib/credential_store.js'), 'utf8');
  const mailStoreSource = fs.readFileSync(path.join(__dirname, '../engine/lib/mail_store.js'), 'utf8');

  assert(credentialSource.includes('// LibraMail 0.4.8 — secrets du trousseau protégés par le coffre principal.'));
  assert(credentialSource.includes('function ensureProtectedSecrets('));
  assert(credentialSource.includes('function snapshotSecrets('));
  assert(credentialSource.includes('function restoreSnapshot('));
  assert(credentialSource.includes('function transformSnapshot('));

  assert(mailStoreSource.includes('MASTER_SECRET,'));
  assert(backend.includes('const SECURITY_SERVICE_SECRETS = [mailStore.MASTER_SECRET];'));
  assert(backend.includes("'security.enable': async ({ password = '' } = {}) => {"));
  assert(backend.includes("'security.changePassword': async ({ currentPassword = '', newPassword = '' } = {}) => {"));
  assert(backend.includes("'security.disable': async ({ password = '' } = {}) => {"));
  assert(backend.includes('credentialStore.ensureProtectedSecrets('));
  assert(backend.includes('credentialStore.restoreSnapshot(snapshot)'));
  assert(backend.includes('masterPassword.verify(password)'));

  const unlockPos = backend.indexOf("'security.unlock':");
  const protectPos = backend.indexOf('credentialStore.ensureProtectedSecrets(', unlockPos);
  // security.unlock possède aussi une branche "protection désactivée" qui peut
  // initialiser directement le runtime. Pour la branche protégée, on vérifie
  // bien que l'initialisation située APRES ensureProtectedSecrets() vient ensuite.
  const initPos = backend.indexOf('initializeRuntimeState();', protectPos);
  assert(unlockPos >= 0 && protectPos > unlockPos && initPos > protectPos);

  console.log('[LibraMail] Tests protection des secrets 0.4.8 : OK');
} finally {
  try { masterPassword.lock(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
