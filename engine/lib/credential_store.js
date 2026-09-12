'use strict';

const masterPassword = require('./master_password');

const SERVICE = 'LibraMail';
const OAUTH_REFRESH_KIND = 'oauth2-refresh'; // LibraMail 0.5.1 — jeton OAuth2 de renouvellement

// LibraMail 0.4.8 — secrets du trousseau protégés par le coffre principal.
// Les entrées restent dans le keyring de l'OS mais, lorsque la protection est
// activée, la valeur qui y est stockée est un blob AES-GCM "vault1:".
let Entry = null;
let loadError = null;

function loadEntry() {
  if (Entry) return Entry;
  if (loadError) throw loadError;
  try {
    Entry = require('@napi-rs/keyring').Entry;
    if (typeof Entry !== 'function') throw new Error('API Entry indisponible');
    return Entry;
  } catch (error) {
    loadError = new Error(`Coffre-fort système indisponible : ${error.message}`);
    throw loadError;
  }
}

function entryFor(accountId, kind) {
  const EntryClass = loadEntry();
  return new EntryClass(SERVICE, `account:${String(accountId)}:${kind}`);
}

function entryForServiceSecret(name) {
  const EntryClass = loadEntry();
  return new EntryClass(SERVICE, `service:${String(name)}`);
}

function accountSecretContext(accountId, kind) {
  return `keyring:account:${String(accountId)}:${String(kind)}`;
}

function serviceSecretContext(name) {
  return `keyring:service:${String(name)}`;
}

function isProtectedValue(value) {
  return String(value || '').startsWith('vault1:');
}

function decodeForStorage(value, context) {
  const raw = value == null ? '' : String(value);
  if (!raw || !isProtectedValue(raw)) return raw;
  return masterPassword.unprotectSecret(raw, context);
}

function encodeForStorage(value, context) {
  const plain = String(value || '');
  if (!plain || !masterPassword.isEnabled()) return plain;
  return masterPassword.protectSecret(plain, context);
}

function readRawEntry(entry) {
  const value = entry.getPassword();
  return value == null ? null : String(value);
}

function writeRawEntry(entry, value) {
  if (value == null) {
    try { entry.deletePassword(); } catch {}
    return true;
  }
  const raw = String(value);
  entry.setPassword(raw);
  const verified = entry.getPassword();
  if (String(verified == null ? '' : verified) !== raw) {
    throw new Error('Vérification du secret stocké impossible');
  }
  return true;
}

function read(accountId, kind) {
  const value = readRawEntry(entryFor(accountId, kind));
  return decodeForStorage(value, accountSecretContext(accountId, kind));
}

function write(accountId, kind, password) {
  const value = String(password || '');
  if (!value) throw new Error(`Mot de passe ${kind.toUpperCase()} vide`);
  const context = accountSecretContext(accountId, kind);
  const stored = encodeForStorage(value, context);
  const entry = entryFor(accountId, kind);
  writeRawEntry(entry, stored);
  const verified = decodeForStorage(readRawEntry(entry), context);
  if (verified !== value) throw new Error(`Vérification du secret ${kind.toUpperCase()} impossible`);
  return true;
}

function remove(accountId, kind) {
  try { return Boolean(entryFor(accountId, kind).deletePassword()); }
  catch { return false; }
}

function storeIncoming(accountId, protocol, incomingPassword, smtpPassword) {
  const kind = String(protocol || 'imap').toLowerCase() === 'pop3' ? 'pop3' : 'imap';
  const oldIncoming = (() => { try { return read(accountId, kind); } catch { return ''; } })();
  const oldSmtp = (() => { try { return read(accountId, 'smtp'); } catch { return ''; } })();
  try {
    write(accountId, kind, incomingPassword);
    write(accountId, 'smtp', smtpPassword || incomingPassword);
    if (kind === 'pop3') remove(accountId, 'imap');
    else remove(accountId, 'pop3');
  } catch (error) {
    try { oldIncoming ? write(accountId, kind, oldIncoming) : remove(accountId, kind); } catch {}
    try { oldSmtp ? write(accountId, 'smtp', oldSmtp) : remove(accountId, 'smtp'); } catch {}
    throw error;
  }
}

function storePair(accountId, imapPassword, smtpPassword) {
  return storeIncoming(accountId, 'imap', imapPassword, smtpPassword);
}

function removePair(accountId) {
  remove(accountId, 'imap');
  remove(accountId, 'pop3');
  remove(accountId, 'smtp');
  remove(accountId, OAUTH_REFRESH_KIND);
}

function readOAuthRefreshToken(accountId) {
  return read(accountId, OAUTH_REFRESH_KIND);
}

function writeOAuthRefreshToken(accountId, refreshToken) {
  return write(accountId, OAUTH_REFRESH_KIND, refreshToken);
}

function removeOAuthRefreshToken(accountId) {
  return remove(accountId, OAUTH_REFRESH_KIND);
}

function hydrate(account) {
  if (!account?.id || account.credentials?.store !== 'system') return account;
  const protocol = String(account.receiveProtocol || 'imap').toLowerCase() === 'pop3' ? 'pop3' : 'imap';
  const incomingPassword = read(account.id, protocol);
  const smtpPassword = read(account.id, 'smtp') || incomingPassword;
  if (protocol === 'pop3' && account.pop3) account.pop3.pass = incomingPassword;
  if (protocol === 'imap' && account.imap) account.imap.pass = incomingPassword;
  if (account.smtp) account.smtp.pass = smtpPassword;
  return account;
}

function migrateLegacy(account) {
  if (!account?.id || account.credentials?.store === 'system') return { migrated: false, account };
  const protocol = String(account.receiveProtocol || 'imap').toLowerCase() === 'pop3' ? 'pop3' : 'imap';
  const incomingPassword = String((protocol === 'pop3' ? account.pop3?.pass : account.imap?.pass) || '');
  const smtpPassword = String(account.smtp?.pass || '') || incomingPassword;
  if (!incomingPassword) return { migrated: false, account };
  storeIncoming(account.id, protocol, incomingPassword, smtpPassword);
  account.credentials = { store: 'system', version: 2, incoming: protocol, smtp: true };
  return { migrated: true, account };
}

function readServiceSecret(name) {
  const value = readRawEntry(entryForServiceSecret(name));
  return decodeForStorage(value, serviceSecretContext(name));
}

function writeServiceSecret(name, value) {
  const secret = String(value || '');
  if (!secret) throw new Error('Secret vide');
  const context = serviceSecretContext(name);
  const stored = encodeForStorage(secret, context);
  const entry = entryForServiceSecret(name);
  writeRawEntry(entry, stored);
  const verified = decodeForStorage(readRawEntry(entry), context);
  if (verified !== secret) throw new Error('Vérification du secret impossible');
  return true;
}

function removeServiceSecret(name) {
  try { return Boolean(entryForServiceSecret(name).deletePassword()); }
  catch { return false; }
}

function secretDescriptors(accountIds = [], serviceNames = []) {
  const descriptors = [];
  const ids = [...new Set((Array.isArray(accountIds) ? accountIds : [])
    .map(value => String(value || '').trim()).filter(Boolean))];
  for (const accountId of ids) {
    for (const kind of ['imap', 'pop3', 'smtp', OAUTH_REFRESH_KIND]) {
      descriptors.push({
        scope: 'account',
        accountId,
        kind,
        context: accountSecretContext(accountId, kind),
      });
    }
  }
  for (const name of [...new Set((Array.isArray(serviceNames) ? serviceNames : [])
    .map(value => String(value || '').trim()).filter(Boolean))]) {
    descriptors.push({
      scope: 'service',
      name,
      context: serviceSecretContext(name),
    });
  }
  return descriptors;
}

function descriptorEntry(item) {
  return item.scope === 'service'
    ? entryForServiceSecret(item.name)
    : entryFor(item.accountId, item.kind);
}

function snapshotSecrets(accountIds = [], serviceNames = []) {
  return secretDescriptors(accountIds, serviceNames).map(item => ({
    ...item,
    value: readRawEntry(descriptorEntry(item)),
  }));
}

function restoreSnapshot(snapshot = []) {
  for (const item of Array.isArray(snapshot) ? snapshot : []) {
    const entry = descriptorEntry(item);
    writeRawEntry(entry, item.value == null ? null : String(item.value));
  }
  return true;
}

function transformSnapshot(snapshot = [], { protect = true } = {}) {
  let changed = 0;
  for (const item of Array.isArray(snapshot) ? snapshot : []) {
    const raw = item.value == null ? null : String(item.value);
    if (raw == null || raw === '') continue;

    const plain = decodeForStorage(raw, item.context);
    const next = protect
      ? masterPassword.protectSecret(plain, item.context)
      : plain;

    if (next === raw) continue;
    const entry = descriptorEntry(item);
    writeRawEntry(entry, next);

    const verifiedRaw = readRawEntry(entry);
    const verifiedPlain = decodeForStorage(verifiedRaw, item.context);
    if (verifiedPlain !== plain) {
      throw new Error('Vérification de la migration d’un secret impossible');
    }
    changed++;
  }
  return changed;
}

function protectionSummary(accountIds = [], serviceNames = []) {
  const summary = { protected: 0, plain: 0, missing: 0, total: 0 };
  for (const item of snapshotSecrets(accountIds, serviceNames)) {
    const raw = item.value == null ? '' : String(item.value);
    if (!raw) {
      summary.missing++;
      continue;
    }
    summary.total++;
    if (isProtectedValue(raw)) summary.protected++;
    else summary.plain++;
  }
  return summary;
}

function ensureProtectedSecrets(accountIds = [], serviceNames = []) {
  if (!masterPassword.isEnabled()) return { changed: 0, ...protectionSummary(accountIds, serviceNames) };
  const snapshot = snapshotSecrets(accountIds, serviceNames);
  const pending = snapshot.filter(item => item.value && !isProtectedValue(item.value));
  if (!pending.length) return { changed: 0, ...protectionSummary(accountIds, serviceNames) };

  try {
    const changed = transformSnapshot(pending, { protect: true });
    return { changed, ...protectionSummary(accountIds, serviceNames) };
  } catch (error) {
    try { restoreSnapshot(snapshot); } catch (rollbackError) {
      throw new Error(`${error.message} ; retour arrière impossible : ${rollbackError.message}`);
    }
    throw error;
  }
}

function serialize(account) {
  const copy = JSON.parse(JSON.stringify(account));
  delete copy.providerKey;
  delete copy._credentialWarning;

  // Les access tokens OAuth2 sont éphémères et ne doivent jamais atteindre
  // accounts.json, même si un futur appelant les place par erreur sur le compte.
  delete copy._oauthAccessToken;
  if (copy.oauth2 && typeof copy.oauth2 === 'object') {
    delete copy.oauth2.accessToken;
    delete copy.oauth2.refreshToken;
  }
  if (copy.authentication && typeof copy.authentication === 'object') {
    delete copy.authentication.accessToken;
    delete copy.authentication.refreshToken;
  }

  if (copy.credentials?.store === 'system') {
    if (copy.imap) delete copy.imap.pass;
    if (copy.pop3) delete copy.pop3.pass;
    if (copy.smtp) delete copy.smtp.pass;
  }
  return copy;
}

module.exports = {
  read, write, storePair, storeIncoming, removePair, hydrate, migrateLegacy, serialize,
  readOAuthRefreshToken, writeOAuthRefreshToken, removeOAuthRefreshToken, OAUTH_REFRESH_KIND,
  readServiceSecret, writeServiceSecret, removeServiceSecret,
  accountSecretContext, serviceSecretContext, isProtectedValue,
  encodeForStorage, decodeForStorage,
  snapshotSecrets, restoreSnapshot, transformSnapshot,
  protectionSummary, ensureProtectedSecrets,
};
