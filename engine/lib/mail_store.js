'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const credentialStore = require('./credential_store');

const MASTER_SECRET = 'mailstore-master-key-v1';
const STORE_VERSION = 1;
let dataDir = '';
let storeDir = '';
let masterKey = null;
let masterSearchKey = null;
let secureAvailable = false;
let secureError = '';
const stores = new Map();

function sanitizeAccountId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'unknown';
}

function storeFileForAccount(baseDataDir, accountId) {
  return path.join(path.resolve(baseDataDir), 'mailstore', `${sanitizeAccountId(accountId)}.db`);
}

function expectedEmlPath(baseDir, row) {
  const folder = String(row.folder || 'INBOX').replace(/[^\w.-]/g, '_');
  return path.join(baseDir, 'mail', String(row.account_id || ''), folder, `${row.uid}.eml`);
}

function ensureMasterKey() {
  if (masterKey) return masterKey;
  try {
    let encoded = credentialStore.readServiceSecret(MASTER_SECRET);
    if (!encoded) {
      encoded = crypto.randomBytes(32).toString('base64');
      credentialStore.writeServiceSecret(MASTER_SECRET, encoded);
    }
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length !== 32) throw new Error('Clé maître invalide');
    masterKey = decoded;
    masterSearchKey = null;
    secureAvailable = true;
    secureError = '';
    return masterKey;
  } catch (error) {
    secureAvailable = false;
    secureError = error.message;
    return null;
  }
}

function accountKey(accountId) {
  const key = ensureMasterKey();
  if (!key) return null;
  return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.from('LibraMail-mailstore-v1'), Buffer.from(String(accountId)), 32));
}

function secureSearchKey() {
  const key = ensureMasterKey();
  if (!key) return null;
  if (!masterSearchKey) {
    masterSearchKey = Buffer.from(crypto.hkdfSync(
      'sha256', key, Buffer.from('LibraMail-search-salt-v1'), Buffer.from('LibraMail-search-index-v1'), 32,
    ));
  }
  return masterSearchKey;
}

function normalizedSearchWords(value) {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
  const matches = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}._@+\-]{1,79}/gu) || [];
  return [...new Set(matches)].slice(0, 6000);
}

function searchTokens(value) {
  const key = secureSearchKey();
  if (!key) return [];
  return normalizedSearchWords(value).map(word =>
    crypto.createHmac('sha256', key).update(word).digest('hex')
  );
}

function protectSnippet(accountId, value) {
  const text = String(value || '').slice(0, 320);
  if (!text) return '';
  const key = accountKey(accountId);
  if (!key) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]);
  return `enc1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

function unprotectSnippet(accountId, value) {
  const text = String(value || '');
  if (!text.startsWith('enc1:')) return text;
  const parts = text.split(':');
  if (parts.length !== 4) return '';
  const key = accountKey(accountId);
  if (!key) return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return '';
  }
}

function openStore(accountId) {
  const id = String(accountId || '');
  if (stores.has(id)) return stores.get(id);
  fs.mkdirSync(storeDir, { recursive: true });
  const file = storeFileForAccount(dataDir, id);
  const database = new Database(file);
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.exec(`
    CREATE TABLE IF NOT EXISTS raw_messages (
      message_id INTEGER PRIMARY KEY,
      iv BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      ciphertext BLOB NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      store_version INTEGER NOT NULL DEFAULT 1
    );
  `);
  stores.set(id, database);
  return database;
}

function encrypt(accountId, raw) {
  const key = accountKey(accountId);
  if (!key) throw new Error(secureError || 'Coffre-fort système indisponible');
  const input = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || '');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const sha256 = crypto.createHash('sha256').update(input).digest('hex');
  return { iv, authTag, ciphertext, sha256, size: input.length };
}

function decrypt(accountId, row) {
  const key = accountKey(accountId);
  if (!key) throw new Error(secureError || 'Coffre-fort système indisponible');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, row.iv);
  decipher.setAuthTag(row.auth_tag);
  const raw = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  if (sha !== row.sha256) throw new Error('Intégrité du message chiffré invalide');
  return raw;
}

function putEncrypted(accountId, messageId, raw) {
  const encrypted = encrypt(accountId, raw);
  const store = openStore(accountId);
  store.prepare(`
    INSERT INTO raw_messages(message_id, iv, auth_tag, ciphertext, sha256, size, created_at, store_version)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(message_id) DO UPDATE SET
      iv=excluded.iv, auth_tag=excluded.auth_tag, ciphertext=excluded.ciphertext,
      sha256=excluded.sha256, size=excluded.size, created_at=excluded.created_at,
      store_version=excluded.store_version
  `).run(Number(messageId), encrypted.iv, encrypted.authTag, encrypted.ciphertext,
         encrypted.sha256, encrypted.size, Date.now(), STORE_VERSION);
  const check = store.prepare('SELECT * FROM raw_messages WHERE message_id=?').get(Number(messageId));
  const verified = decrypt(accountId, check);
  const original = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || '');
  if (!verified.equals(original)) throw new Error('Vérification du message chiffré impossible');
  return { kind: 'encrypted', ref: String(messageId), sha256: encrypted.sha256, emlPath: '' };
}

function putLegacyEml(row, raw) {
  const target = expectedEmlPath(dataDir, row);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, raw);
  return {
    kind: 'eml', ref: '',
    sha256: crypto.createHash('sha256').update(Buffer.isBuffer(raw) ? raw : Buffer.from(raw || '')).digest('hex'),
    emlPath: target,
  };
}

function storeMessage(row, raw) {
  if (ensureMasterKey()) return putEncrypted(row.account_id, row.id, raw);
  return putLegacyEml(row, raw);
}

function readLegacyMessage(row, baseDir = dataDir) {
  const expected = expectedEmlPath(baseDir, row);
  const candidates = [
    expected,
    row?.eml_path && (path.isAbsolute(row.eml_path) ? row.eml_path : path.resolve(baseDir, row.eml_path)),
  ].filter(Boolean);
  const found = candidates.find(file => fs.existsSync(file));
  return found ? { raw: fs.readFileSync(found), path: found } : null;
}

function readMessage(row) {
  if (!row) throw new Error('Message introuvable');
  if (String(row.storage_kind || '') === 'encrypted') {
    try {
      const store = openStore(row.account_id);
      const stored = store.prepare('SELECT * FROM raw_messages WHERE message_id=?').get(Number(row.id));
      if (!stored) throw new Error(`Message chiffré introuvable dans le magasin local (${row.id})`);
      return decrypt(row.account_id, stored);
    } catch (error) {
      // Une coupure exactement entre la mise à jour de l'index et la suppression
      // de l'ancien .eml peut laisser les deux copies. La copie historique est
      // alors un filet de sécurité, jamais une raison de rendre le mail illisible.
      const legacy = readLegacyMessage(row);
      if (legacy) {
        console.warn(`[LibraMail] Magasin chiffré indisponible pour le message ${row.id}; repli temporaire sur ${legacy.path}: ${error.message}`);
        return legacy.raw;
      }
      throw error;
    }
  }
  const legacy = readLegacyMessage(row);
  if (!legacy) throw new Error(`Fichier local du message introuvable : ${expectedEmlPath(dataDir, row)}`);
  return legacy.raw;
}

function removeMessage(row) {
  if (!row) return;
  if (String(row.storage_kind || '') === 'encrypted') {
    try { openStore(row.account_id).prepare('DELETE FROM raw_messages WHERE message_id=?').run(Number(row.id)); } catch {}
  }
  const candidates = [row.eml_path, expectedEmlPath(dataDir, row)].filter(Boolean);
  for (const file of candidates) {
    try {
      const target = path.isAbsolute(file) ? file : path.resolve(dataDir, file);
      fs.rmSync(target, { force: true });
    } catch {}
  }
}

function removeAccount(accountId) {
  const id = String(accountId || '');
  const store = stores.get(id);
  if (store) {
    try { store.close(); } catch {}
    stores.delete(id);
  }
  const file = storeFileForAccount(dataDir, id);
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(file + suffix, { force: true }); } catch {}
  }
}

function pruneEmptyDirectories(root) {
  if (!root || !fs.existsSync(root)) return;
  const walk = directory => {
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(directory, entry.name));
    }
    try {
      if (fs.readdirSync(directory).length === 0) {
        fs.rmdirSync(directory);
        return true;
      }
    } catch {}
    return false;
  };
  walk(root);
}

async function migrateLegacyMessages(indexDb, { onProgress = null } = {}) {
  if (!ensureMasterKey()) {
    console.warn(`[LibraMail] Stockage chiffré indisponible, conservation temporaire des .eml : ${secureError}`);
    return { encrypted: 0, skipped: 0, unavailable: true, error: secureError };
  }
  // Une migration terminée ne doit pas imposer de relire/déchiffrer tous les
  // messages à chaque démarrage. On ne reprend le scan que si un ancien .eml
  // ou une entrée non chiffrée a réellement réapparu (restauration, repli, etc.).
  try {
    const marker = indexDb.prepare("SELECT value FROM app_meta WHERE key='mailstore_v1_migrated'").get();
    const pending = Number(indexDb.prepare("SELECT COUNT(*) AS n FROM messages WHERE COALESCE(storage_kind,'eml') <> 'encrypted'").get()?.n) || 0;
    if (marker?.value === '1' && pending === 0) {
      return { encrypted: 0, skipped: 0, unavailable: false, complete: true, alreadyMigrated: true };
    }
  } catch {}
  const rows = indexDb.prepare(`
    SELECT id, account_id, folder, uid, eml_path, storage_kind, storage_ref, storage_sha256
      FROM messages
     ORDER BY id
  `).all();
  const update = indexDb.prepare(`UPDATE messages
      SET storage_kind='encrypted', storage_ref=?, storage_sha256=?, eml_path=''
    WHERE id=?`);
  let encrypted = 0;
  let skipped = 0;
  let scanned = 0;
  for (const row of rows) {
    scanned++;
    if (String(row.storage_kind || '') === 'encrypted') {
      try {
        // Lecture complète = vérification GCM + SHA. Si elle réussit, une
        // éventuelle copie .eml résiduelle peut être supprimée sans risque.
        const store = openStore(row.account_id);
        const stored = store.prepare('SELECT * FROM raw_messages WHERE message_id=?').get(Number(row.id));
        if (!stored) throw new Error('entrée absente du magasin');
        decrypt(row.account_id, stored);
        if (row.eml_path || fs.existsSync(expectedEmlPath(dataDir, row))) {
          const legacy = readLegacyMessage(row);
          if (legacy) fs.rmSync(legacy.path, { force: true });
        }
      } catch (error) {
        // Si le .eml de secours existe encore, on reconstruit l'entrée chiffrée.
        const legacy = readLegacyMessage(row);
        if (!legacy) { skipped++; continue; }
        const descriptor = putEncrypted(row.account_id, row.id, legacy.raw);
        update.run(descriptor.ref, descriptor.sha256, row.id);
        fs.rmSync(legacy.path, { force: true });
        encrypted++;
      }
      if (scanned % 25 === 0) await new Promise(resolve => setImmediate(resolve));
      continue;
    }
    let raw;
    try { raw = readMessage(row); }
    catch { skipped++; continue; }
    const descriptor = putEncrypted(row.account_id, row.id, raw);
    update.run(descriptor.ref, descriptor.sha256, row.id);
    try {
      const eml = row.eml_path || expectedEmlPath(dataDir, row);
      if (eml) fs.rmSync(path.isAbsolute(eml) ? eml : path.resolve(dataDir, eml), { force: true });
    } catch {}
    encrypted++;
    if (encrypted === 1 || encrypted % 250 === 0) onProgress?.({ encrypted, total: rows.length });
    // Laisse respirer l'interface et le serveur local pendant une migration
    // volumineuse (plusieurs milliers de messages avec pièces jointes).
    if (scanned % 25 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  let complete = false;
  try {
    const pending = Number(indexDb.prepare("SELECT COUNT(*) AS n FROM messages WHERE COALESCE(storage_kind,'eml') <> 'encrypted'").get()?.n) || 0;
    complete = pending === 0 && skipped === 0;
    if (complete) {
      indexDb.prepare(`INSERT INTO app_meta(key,value) VALUES ('mailstore_v1_migrated','1')
                       ON CONFLICT(key) DO UPDATE SET value='1'`).run();
      pruneEmptyDirectories(path.join(dataDir, 'mail'));
    }
  } catch {}
  return { encrypted, skipped, unavailable: false, complete };
}

function verifyIndexCoverage(indexDb, baseDataDir = dataDir) {
  const columns = new Set(indexDb.prepare('PRAGMA table_info(messages)').all().map(row => String(row.name)));
  const storageExpression = columns.has('storage_kind') ? 'storage_kind' : "'eml' AS storage_kind";
  const emlExpression = columns.has('eml_path') ? 'eml_path' : "'' AS eml_path";
  const rows = indexDb.prepare(`
    SELECT id, account_id, folder, uid, ${emlExpression}, ${storageExpression}
      FROM messages
     ORDER BY id
  `).all();
  let encrypted = 0;
  let legacy = 0;
  const missingEncrypted = [];
  const missingLegacy = [];
  const readers = new Map();
  try {
    for (const row of rows) {
      if (String(row.storage_kind || '') === 'encrypted') {
        encrypted++;
        const accountId = String(row.account_id || '');
        let entry = readers.get(accountId);
        if (!entry) {
          const file = storeFileForAccount(baseDataDir, accountId);
          if (!fs.existsSync(file)) {
            entry = { missing: true, file };
          } else {
            try {
              const database = new Database(file, { readonly: true, fileMustExist: true });
              const integrity = database.pragma('integrity_check', { simple: true });
              if (String(integrity).toLowerCase() !== 'ok') throw new Error(`integrity_check=${integrity}`);
              entry = {
                database,
                file,
                exists: database.prepare('SELECT 1 FROM raw_messages WHERE message_id=?'),
              };
            } catch (error) {
              entry = { missing: true, file, error: error.message };
            }
          }
          readers.set(accountId, entry);
        }
        if (entry.missing || !entry.exists.get(Number(row.id))) {
          missingEncrypted.push({ id: Number(row.id), accountId, file: entry.file, error: entry.error || '' });
        }
        continue;
      }
      legacy++;
      const expected = expectedEmlPath(baseDataDir, row);
      const candidates = [
        expected,
        row.eml_path && (path.isAbsolute(row.eml_path) ? row.eml_path : path.resolve(baseDataDir, row.eml_path)),
      ].filter(Boolean);
      if (!candidates.some(file => fs.existsSync(file))) {
        missingLegacy.push({ id: Number(row.id), accountId: String(row.account_id || ''), expected });
      }
    }
  } finally {
    for (const entry of readers.values()) {
      try { entry.database?.close(); } catch {}
    }
  }
  return {
    total: rows.length,
    encrypted,
    legacy,
    missingEncrypted,
    missingLegacy,
    complete: !missingEncrypted.length && !missingLegacy.length,
  };
}

function exportKeyEnvelope(password) {
  const secret = String(password || '');
  if (secret.length < 8) throw new Error('Le mot de passe de sauvegarde doit contenir au moins 8 caractères.');
  const key = ensureMasterKey();
  if (!key) throw new Error(secureError || 'Clé maître indisponible');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const wrappingKey = crypto.scryptSync(secret, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
  return {
    format: 'LibraMail-mailstore-key',
    version: 1,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function unwrapKeyEnvelope(envelope, password) {
  const secret = String(password || '');
  if (!envelope || envelope.format !== 'LibraMail-mailstore-key' || Number(envelope.version) !== 1) {
    throw new Error('Enveloppe de clé de sauvegarde invalide.');
  }
  if (!secret) throw new Error('Mot de passe de sauvegarde requis.');
  try {
    const salt = Buffer.from(envelope.salt, 'base64');
    const iv = Buffer.from(envelope.iv, 'base64');
    const authTag = Buffer.from(envelope.authTag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    const wrappingKey = crypto.scryptSync(secret, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, iv);
    decipher.setAuthTag(authTag);
    const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (key.length !== 32) throw new Error('Clé restaurée invalide');
    return key;
  } catch {
    throw new Error('Mot de passe de sauvegarde incorrect ou enveloppe de clé endommagée.');
  }
}

function importKeyEnvelope(envelope, password) {
  const key = unwrapKeyEnvelope(envelope, password);
  credentialStore.writeServiceSecret(MASTER_SECRET, key.toString('base64'));
  masterKey = key;
  masterSearchKey = null;
  secureAvailable = true;
  secureError = '';
  return true;
}

function stashMasterKey(name) {
  const encoded = credentialStore.readServiceSecret(MASTER_SECRET);
  if (!encoded) return false;
  credentialStore.writeServiceSecret(String(name), encoded);
  return true;
}

function restoreStashedMasterKey(name) {
  const encoded = credentialStore.readServiceSecret(String(name));
  if (!encoded) return false;
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('Clé maître de retour arrière invalide');
  credentialStore.writeServiceSecret(MASTER_SECRET, encoded);
  masterKey = key;
  masterSearchKey = null;
  secureAvailable = true;
  secureError = '';
  return true;
}

function removeStashedMasterKey(name) {
  return credentialStore.removeServiceSecret(String(name));
}

function checkpointAll() {
  for (const database of stores.values()) {
    try { database.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  }
}


function status() {
  return { available: secureAvailable, error: secureError, directory: storeDir };
}

function init(baseDataDir) {
  dataDir = path.resolve(baseDataDir);
  storeDir = path.join(dataDir, 'mailstore');
  fs.mkdirSync(storeDir, { recursive: true });
  ensureMasterKey();
  return status();
}

function close() {
  for (const database of stores.values()) {
    try { database.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    try { database.close(); } catch {}
  }
  stores.clear();
}

module.exports = {
  init, close, status, storeMessage, readMessage, removeMessage, removeAccount,
  migrateLegacyMessages, expectedEmlPath, storeFileForAccount, verifyIndexCoverage,
  exportKeyEnvelope, importKeyEnvelope, unwrapKeyEnvelope, checkpointAll,
  stashMasterKey, restoreStashedMasterKey, removeStashedMasterKey,
  searchTokens, protectSnippet, unprotectSnippet,
};
