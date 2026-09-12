/**
 * LibraMail 0.5.1 — non-régression du socle OAuth2.
 * Aucun accès réseau, aucun secret réel, aucun appel au keyring.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const mailAuth = require('../engine/lib/mail_auth');
const credentialStore = require('../engine/lib/credential_store');

// 1) Compatibilité stricte du chemin historique 0.5.0.
const legacy = {
  email: 'legacy@example.test',
  imap: { user: 'imap-user', pass: 'imap-password' },
  pop3: { user: 'pop-user', pass: 'pop-password' },
  smtp: { user: 'smtp-user', pass: 'smtp-password' },
};
assert.strictEqual(mailAuth.typeFor(legacy), 'password');
assert.deepStrictEqual(mailAuth.imapAuth(legacy), {
  user: 'imap-user',
  pass: 'imap-password',
});
assert.deepStrictEqual(mailAuth.smtpAuth(legacy), {
  user: 'smtp-user',
  pass: 'smtp-password',
});

const explicitPassword = {
  ...legacy,
  authentication: { type: 'password' },
};
assert.deepStrictEqual(mailAuth.imapAuth(explicitPassword), mailAuth.imapAuth(legacy));
assert.deepStrictEqual(mailAuth.smtpAuth(explicitPassword), mailAuth.smtpAuth(legacy));

// 2) Construction OAuth2 standard pour ImapFlow et Nodemailer.
const oauth = {
  id: 'oauth-account',
  email: 'person@example.test',
  authentication: { type: 'oauth2', provider: 'microsoft' },
  imap: { user: 'person@example.test' },
  smtp: { user: 'person@example.test' },
  _oauthAccessToken: 'access-token-for-test',
};
assert.strictEqual(mailAuth.typeFor(oauth), 'oauth2');
assert.strictEqual(mailAuth.providerFor(oauth), 'microsoft');
assert.deepStrictEqual(mailAuth.imapAuth(oauth), {
  user: 'person@example.test',
  accessToken: 'access-token-for-test',
});
assert.deepStrictEqual(mailAuth.smtpAuth(oauth), {
  type: 'OAuth2',
  user: 'person@example.test',
  accessToken: 'access-token-for-test',
});
assert.throws(
  () => mailAuth.imapAuth({ ...oauth, _oauthAccessToken: '' }),
  /Jeton d’accès microsoft indisponible/,
);

// 3) Le refresh token participe à la migration/protection du mot de passe principal.
const credentialsSource = fs.readFileSync(path.join(ROOT, 'engine/lib/credential_store.js'), 'utf8');
assert.strictEqual(credentialStore.OAUTH_REFRESH_KIND, 'oauth2-refresh');
assert(credentialsSource.includes("['imap', 'pop3', 'smtp', OAUTH_REFRESH_KIND]"));

// 4) Aucun token OAuth2 ne peut être sérialisé dans accounts.json.
const serialized = credentialStore.serialize({
  ...oauth,
  credentials: { store: 'system', version: 2 },
  imap: { ...oauth.imap, pass: 'must-not-leak' },
  smtp: { ...oauth.smtp, pass: 'must-not-leak-either' },
  oauth2: {
    provider: 'microsoft',
    accessToken: 'must-not-leak',
    refreshToken: 'must-not-leak',
  },
  authentication: {
    type: 'oauth2',
    provider: 'microsoft',
    accessToken: 'must-not-leak',
    refreshToken: 'must-not-leak',
  },
});
assert.strictEqual(serialized._oauthAccessToken, undefined);
assert.strictEqual(serialized.imap.pass, undefined);
assert.strictEqual(serialized.smtp.pass, undefined);
assert.strictEqual(serialized.oauth2.accessToken, undefined);
assert.strictEqual(serialized.oauth2.refreshToken, undefined);
assert.strictEqual(serialized.authentication.accessToken, undefined);
assert.strictEqual(serialized.authentication.refreshToken, undefined);
assert.strictEqual(serialized.authentication.type, 'oauth2');
assert.strictEqual(serialized.authentication.provider, 'microsoft');

// 5) Les transports réellement utilisés sont branchés sur le module commun.
const imapSource = fs.readFileSync(path.join(ROOT, 'engine/lib/imap.js'), 'utf8');
const smtpSource = fs.readFileSync(path.join(ROOT, 'engine/lib/smtp.js'), 'utf8');
assert(imapSource.includes("const mailAuth = require('./mail_auth')"));
assert(imapSource.includes('auth: mailAuth.imapAuth(account)'));
assert(smtpSource.includes("const mailAuth = require('./mail_auth')"));
assert(smtpSource.includes('auth: mailAuth.smtpAuth(account)'));

console.log('[LibraMail] Test socle OAuth2 0.5.1 : OK');
