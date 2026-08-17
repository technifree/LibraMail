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

function entryForServiceSecret(name) {
  const EntryClass = loadEntry();
  return new EntryClass(SERVICE, `service:${String(name)}`);
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
  const value = entryForServiceSecret(name).getPassword();
  return value == null ? '' : String(value);
}

function writeServiceSecret(name, value) {
  const secret = String(value || '');
  if (!secret) throw new Error('Secret vide');
  const entry = entryForServiceSecret(name);
  entry.setPassword(secret);
  const verified = entry.getPassword();
  if (String(verified || '') !== secret) throw new Error('Vérification du secret impossible');
  return true;
}

function removeServiceSecret(name) {
  try { return Boolean(entryForServiceSecret(name).deletePassword()); }
  catch { return false; }
}

function serialize(account) {
  const copy = JSON.parse(JSON.stringify(account));
  delete copy.providerKey;
  delete copy._credentialWarning;
  if (copy.credentials?.store === 'system') {
    if (copy.imap) delete copy.imap.pass;
    if (copy.pop3) delete copy.pop3.pass;
    if (copy.smtp) delete copy.smtp.pass;
  }
  return copy;
}

module.exports = { read, write, storePair, storeIncoming, removePair, hydrate, migrateLegacy, serialize, readServiceSecret, writeServiceSecret, removeServiceSecret };
