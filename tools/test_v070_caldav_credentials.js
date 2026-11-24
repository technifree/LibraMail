'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const master = require('../engine/lib/master_password');
const store = require('../engine/lib/credential_store');
const creds = require('../engine/lib/calendar_caldav_credentials');

// Real vault and credential-store logic; substitute only the OS keyring.
const entries = new Map();
let corruptNextWrite = false;
let unavailable = false;
let calls = 0;
class Entry {
  constructor(service, name) { this.key = `${service}:${name}`; }
  getPassword() {
    calls++;
    if (unavailable) throw Error('secret in native error must not escape');
    return entries.get(this.key) ?? null;
  }
  setPassword(value) {
    calls++;
    if (corruptNextWrite) { corruptNextWrite = false; entries.set(this.key, 'corrupted'); return; }
    entries.set(this.key, value);
  }
  deletePassword() { return entries.delete(this.key); }
}
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === '@napi-rs/keyring') return { Entry };
  return originalLoad.call(this, request, ...args);
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-caldav-vault-'));
const service = store.CALENDAR_CALDAV_SERVICE_SECRET;
const services = [service];
const raw = () => entries.get(`LibraMail:service:${service}`);
const id = crypto.randomUUID();
const id2 = crypto.randomUUID();
const apple = { provider: 'icloud', username: 'example@invalid.test' };
const nextcloud = { serverURL: 'https://nextcloud.invalid/remote.php/dav/', username: 'local' };
const password = 'abcd-efgh-ijkl-mnop';
const code = expected => error => error.code === expected && !error.message.includes(password);
try {
  master.init(dir);
  assert.equal(creds.readPassword(id, apple), null);
  assert.equal(creds.putPassword(id, apple, password), true);
  assert.equal(creds.putPassword(id2, nextcloud, 'other-password'), true);
  assert.equal(creds.readPassword(id, { ...apple, serverURL: 'https://caldav.icloud.com/' }), password);
  assert.equal(creds.readPassword(id2, nextcloud), 'other-password');
  assert(!raw().includes(apple.username));
  assert(!raw().includes('https://'));
  assert.throws(() => creds.readPassword(id, { ...apple, username: 'other' }), code('CREDENTIAL_BINDING_MISMATCH'));
  assert.throws(() => creds.readPassword(id2, { ...nextcloud, serverURL: 'https://evil.invalid/' }), code('CREDENTIAL_BINDING_MISMATCH'));
  assert.throws(() => creds.putPassword(id, { ...apple, serverURL: 'https://caldav.icloud.com.evil.invalid/' }, password), code('INVALID_URL'));
  assert.throws(() => creds.putPassword(id, { ...apple, serverURL: 'http://caldav.icloud.com/' }, password), code('INVALID_URL'));
  assert.throws(() => creds.putPassword('__proto__', apple, password), code('INVALID_CREDENTIAL_ID'));
  assert.throws(() => creds.putPassword(id, apple, 'bad\nsecret'), code('INVALID_CREDENTIALS'));
  const previous = raw();
  corruptNextWrite = true;
  assert.throws(() => creds.putPassword(id, apple, 'new-password'), code('CREDENTIAL_STORE_UNAVAILABLE'));
  assert.equal(raw(), previous);
  unavailable = true;
  assert.throws(() => creds.readPassword(id, apple), code('CREDENTIAL_STORE_UNAVAILABLE'));
  unavailable = false;
  entries.set(`LibraMail:service:${service}`, '{bad json');
  assert.throws(() => creds.putPassword(id, apple, password), code('CREDENTIAL_STORE_INVALID'));
  assert.equal(raw(), '{bad json');
  entries.set(`LibraMail:service:${service}`, previous);
  assert.throws(() => creds.putPassword(crypto.randomUUID(), apple, 'x'.repeat(512)), code('CREDENTIAL_STORE_FULL'));
  assert.equal(raw(), previous);

  // Exercise exactly the same migration machinery as security.enable/unlock/disable.
  master.enable('Master-test-070!');
  store.ensureProtectedSecrets([], services);
  assert(raw().startsWith('vault1:'));
  assert(!raw().includes(password));
  assert.equal(store.protectionSummary([], services).protected, 1);
  master.lock();
  const oldCalls = calls;
  assert.throws(() => creds.readPassword(id, apple), code('CREDENTIALS_LOCKED'));
  assert.throws(() => creds.putPassword(id, apple, 'replacement'), code('CREDENTIALS_LOCKED'));
  assert.throws(() => creds.removePassword(id), code('CREDENTIALS_LOCKED'));
  assert.equal(calls, oldCalls);
  master.unlock('Master-test-070!');
  assert.equal(creds.readPassword(id, apple), password);
  master.changePassword('Master-test-070!', 'Master-new-070!');
  assert.equal(creds.readPassword(id, apple), password);
  assert.equal(creds.putPassword(id, apple, 'replacement'), true);
  assert(raw().startsWith('vault1:'));
  assert.equal(creds.readPassword(id, apple), 'replacement');
  assert.equal(creds.readPassword(id2, nextcloud), 'other-password');
  assert.equal(creds.removePassword(id), true);
  assert.equal(creds.removePassword(id), false);
  assert.equal(creds.readPassword(id, apple), null);
  assert.equal(creds.readPassword(id2, nextcloud), 'other-password');
  store.transformSnapshot(store.snapshotSecrets([], services), { protect: false });
  master.disable('Master-new-070!');
  assert.equal(creds.readPassword(id2, nextcloud), 'other-password');
  assert.equal(creds.removePassword(id2), true);
  assert.equal(raw(), '{}');
  assert.equal(creds.readPassword(id2, nextcloud), null);
  assert.deepEqual(fs.readdirSync(dir), []);
  const backend = fs.readFileSync(path.join(__dirname, '../engine/backend.js'), 'utf8');
  assert.match(backend, /const SECURITY_SERVICE_SECRETS = \[[\s\S]*?credentialStore\.CALENDAR_CALDAV_SERVICE_SECRET,[\s\S]*?\];/);
  console.log('[OK] LibraMail 0.7.0 : coffre CalDAV, liaison des identifiants, verrouillage, migrations et échecs du trousseau');
} finally {
  Module._load = originalLoad;
  master.lock();
  fs.rmSync(dir, { recursive: true, force: true });
}
