'use strict';

const SERVICE = 'LibraMail';
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

function read(accountId, kind) {
  const value = entryFor(accountId, kind).getPassword();
  return value == null ? '' : String(value);
}

function write(accountId, kind, password) {
  const value = String(password || '');
  if (!value) throw new Error(`Mot de passe ${kind.toUpperCase()} vide`);
  const entry = entryFor(accountId, kind);
  entry.setPassword(value);
  const verified = entry.getPassword();
  if (String(verified || '') !== value) throw new Error(`Vérification du secret ${kind.toUpperCase()} impossible`);
  return true;
}

function remove(accountId, kind) {
  try { return Boolean(entryFor(accountId, kind).deletePassword()); }
  catch { return false; }
}

function storePair(accountId, imapPassword, smtpPassword) {
  const oldImap = (() => { try { return read(accountId, 'imap'); } catch { return ''; } })();
  const oldSmtp = (() => { try { return read(accountId, 'smtp'); } catch { return ''; } })();
  try {
    write(accountId, 'imap', imapPassword);
    write(accountId, 'smtp', smtpPassword || imapPassword);
  } catch (error) {
    try { oldImap ? write(accountId, 'imap', oldImap) : remove(accountId, 'imap'); } catch {}
    try { oldSmtp ? write(accountId, 'smtp', oldSmtp) : remove(accountId, 'smtp'); } catch {}
    throw error;
  }
}

function removePair(accountId) {
  remove(accountId, 'imap');
  remove(accountId, 'smtp');
}

function hydrate(account) {
  if (!account?.id || account.credentials?.store !== 'system') return account;
  const imapPassword = read(account.id, 'imap');
  const smtpPassword = read(account.id, 'smtp') || imapPassword;
  if (account.imap) account.imap.pass = imapPassword;
  if (account.smtp) account.smtp.pass = smtpPassword;
  return account;
}

function migrateLegacy(account) {
  if (!account?.id || account.credentials?.store === 'system') return { migrated: false, account };
  const imapPassword = String(account.imap?.pass || '');
  const smtpPassword = String(account.smtp?.pass || '') || imapPassword;
  if (!imapPassword) return { migrated: false, account };
  storePair(account.id, imapPassword, smtpPassword);
  account.credentials = { store: 'system', version: 1, imap: true, smtp: true };
  return { migrated: true, account };
}

function serialize(account) {
  const copy = JSON.parse(JSON.stringify(account));
  delete copy.providerKey;
  delete copy._credentialWarning;
  if (copy.credentials?.store === 'system') {
    if (copy.imap) delete copy.imap.pass;
    if (copy.smtp) delete copy.smtp.pass;
  }
  return copy;
}

module.exports = { read, write, storePair, removePair, hydrate, migrateLegacy, serialize };
