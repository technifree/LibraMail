'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const masterPassword = require('../engine/lib/master_password');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-master-password-'));
const data = path.join(root, 'data');
const securityFile = path.join(data, 'security.json');

try {
  let state = masterPassword.init(data);
  assert.strictEqual(state.enabled, false);
  assert.strictEqual(state.locked, false);
  assert.strictEqual(fs.existsSync(securityFile), false);

  assert.throws(
    () => masterPassword.enable('court'),
    /au moins 8 caractères/i,
  );

  const password1 = 'MotDePasse-Maitre-048!';
  const password2 = 'Nouveau-MotDePasse-048!';
  const accountContext = 'account:test-account:imap';
  const otherContext = 'account:test-account:smtp';
  const secret = 'imap-super-secret';

  state = masterPassword.enable(password1);
  assert.strictEqual(state.enabled, true);
  assert.strictEqual(state.locked, false);
  assert.strictEqual(fs.existsSync(securityFile), true);

  const disk = fs.readFileSync(securityFile, 'utf8');
  assert(!disk.includes(password1));
  assert(!disk.includes(secret));
  const parsed = JSON.parse(disk);
  assert.strictEqual(parsed.format, 'LibraMail-master-password');
  assert.strictEqual(parsed.version, 1);
  assert.strictEqual(parsed.kdf, 'scrypt');

  const protectedSecret = masterPassword.protectSecret(secret, accountContext);
  assert(protectedSecret.startsWith('vault1:'));
  assert(!protectedSecret.includes(secret));
  assert.strictEqual(
    masterPassword.unprotectSecret(protectedSecret, accountContext),
    secret,
  );
  assert.throws(
    () => masterPassword.unprotectSecret(protectedSecret, otherContext),
    /contexte incorrect|illisible/i,
  );

  state = masterPassword.lock();
  assert.strictEqual(state.enabled, true);
  assert.strictEqual(state.locked, true);
  assert.throws(
    () => masterPassword.unprotectSecret(protectedSecret, accountContext),
    /verrouillé/i,
  );
  assert.throws(
    () => masterPassword.unlock('Mauvais-MotDePasse-048!'),
    /incorrect/i,
  );

  state = masterPassword.unlock(password1);
  assert.strictEqual(state.locked, false);
  assert.strictEqual(
    masterPassword.unprotectSecret(protectedSecret, accountContext),
    secret,
  );

  state = masterPassword.changePassword(password1, password2);
  assert.strictEqual(state.enabled, true);
  assert.strictEqual(state.locked, false);

  masterPassword.lock();
  masterPassword.init(data);
  assert.throws(() => masterPassword.unlock(password1), /incorrect/i);
  state = masterPassword.unlock(password2);
  assert.strictEqual(state.locked, false);

  // Le changement de mot de passe ne change pas la clé de coffre :
  // les secrets déjà protégés restent lisibles.
  assert.strictEqual(
    masterPassword.unprotectSecret(protectedSecret, accountContext),
    secret,
  );

  // Une configuration de sécurité existante mais corrompue doit échouer
  // fermement : elle ne doit jamais être interprétée comme "protection désactivée".
  masterPassword.lock();
  fs.writeFileSync(securityFile, '{"format":"invalide"}\n', 'utf8');
  assert.throws(() => masterPassword.init(data), /format|invalide/i);

  console.log('[LibraMail] Tests cœur mot de passe principal 0.4.8 : OK');
} finally {
  try { masterPassword.lock(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
