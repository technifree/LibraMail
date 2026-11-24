'use strict';

// No file, RPC or network access. Use the existing keyring and master-password
// migration. Keep the bundle within the Windows credential blob size even
// after the existing vault1 AES-GCM/base64 envelope has been applied.
const crypto = require('node:crypto');
const store = require('./credential_store');
const masterPassword = require('./master_password');
const { CalDavError } = require('./calendar_caldav');
const SERVICE = store.CALENDAR_CALDAV_SERVICE_SECRET;
const MAX_BUNDLE_BYTES = 850;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const fail = code => { throw new CalDavError(code); };

function validateID(id) {
  if (typeof id !== 'string' || !ID.test(id)) fail('INVALID_CREDENTIAL_ID');
  return id;
}
function validatePassword(password) {
  if (typeof password !== 'string' || !password || /[\x00-\x1f\x7f]/.test(password) ||
      Buffer.byteLength(password, 'utf8') > 512) fail('INVALID_CREDENTIALS');
  return password;
}
function binding({ provider = 'caldav', serverURL, username } = {}) {
  if (!['caldav', 'icloud'].includes(provider) || typeof username !== 'string' ||
      !username.trim() || /[:\x00-\x1f\x7f]/.test(username) || Buffer.byteLength(username) > 512)
    fail('INVALID_CREDENTIALS');
  if (provider === 'icloud' && !serverURL) serverURL = 'https://caldav.icloud.com/';
  if (typeof serverURL !== 'string' || !serverURL || serverURL.length > 4096 || /[\x00-\x20\x7f\\]/.test(serverURL)) fail('INVALID_URL');
  let url;
  try { url = new URL(serverURL); } catch { fail('INVALID_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('INVALID_URL');
  if (provider === 'icloud' && (url.port || !/^(?:caldav|p[0-9]{1,4}-caldav)\.icloud\.com$/.test(url.hostname)))
    fail('INVALID_URL');
  // Bind to the exact canonical entry URL, not any server returned by discovery.
  // Metadata changes require an explicit credential replacement.
  return crypto.createHash('sha256').update(JSON.stringify([provider, url.href, username])).digest('hex');
}
function unlocked() {
  if (masterPassword.isLocked()) fail('CREDENTIALS_LOCKED');
}
function parse(raw) {
  const result = Object.create(null);
  if (raw === '' || raw === null) return result;
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BUNDLE_BYTES) fail('CREDENTIAL_STORE_INVALID');
  let obj;
  try { obj = JSON.parse(raw); } catch { fail('CREDENTIAL_STORE_INVALID'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail('CREDENTIAL_STORE_INVALID');
  for (const [id, item] of Object.entries(obj)) {
    if (!ID.test(id) || !item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).length !== 2 || typeof item.binding !== 'string' || !DIGEST.test(item.binding)) fail('CREDENTIAL_STORE_INVALID');
    try { validatePassword(item.password); } catch { fail('CREDENTIAL_STORE_INVALID'); }
    result[id] = { binding: item.binding, password: item.password };
  }
  return result;
}
function load() {
  unlocked();
  let raw;
  try { raw = store.readServiceSecret(SERVICE); } catch { fail('CREDENTIAL_STORE_UNAVAILABLE'); }
  return parse(raw);
}
function save(bundle) {
  unlocked();
  const raw = JSON.stringify(bundle);
  if (Buffer.byteLength(raw, 'utf8') > MAX_BUNDLE_BYTES) fail('CREDENTIAL_STORE_FULL');
  // Do not fall back to disk, nor expose the original keyring error. Retain
  // the previous raw entry if a write/read-back verification fails.
  let snapshot;
  try { snapshot = store.snapshotSecrets([], [SERVICE]); }
  catch { fail('CREDENTIAL_STORE_UNAVAILABLE'); }
  try { store.writeServiceSecret(SERVICE, raw); }
  catch {
    try {
      const now = store.snapshotSecrets([], [SERVICE]);
      if (now[0].value !== snapshot[0].value) store.restoreSnapshot(snapshot);
      if (store.snapshotSecrets([], [SERVICE])[0].value !== snapshot[0].value) fail('CREDENTIAL_STORE_ROLLBACK_FAILED');
    } catch { fail('CREDENTIAL_STORE_ROLLBACK_FAILED'); }
    fail('CREDENTIAL_STORE_UNAVAILABLE');
  }
}
function putPassword(id, identity, password) {
  validateID(id);
  const key = binding(identity);
  validatePassword(password);
  const bundle = load();
  bundle[id] = { binding: key, password };
  save(bundle);
  return true;
}
function readPassword(id, identity) {
  validateID(id);
  const key = binding(identity);
  const item = load()[id];
  if (!item) return null;
  if (item.binding !== key) fail('CREDENTIAL_BINDING_MISMATCH');
  return item.password;
}
function removePassword(id) {
  validateID(id);
  const bundle = load();
  if (!Object.hasOwn(bundle, id)) return false;
  delete bundle[id];
  // A verified empty bundle avoids the older keyring remove API's silent
  // failure on delete. It contains no credentials and remains migratable.
  save(bundle);
  return true;
}
module.exports = { putPassword, readPassword, removePassword, MAX_BUNDLE_BYTES };
