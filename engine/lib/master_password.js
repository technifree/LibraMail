'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const atomicFile = require('./atomic_file');

const FORMAT = 'LibraMail-master-password';
const VERSION = 1;
const MIN_PASSWORD_LENGTH = 8;
const KDF = Object.freeze({
  name: 'scrypt',
  N: 1 << 15,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});
const ENVELOPE_AAD = Buffer.from('LibraMail-master-password-envelope-v1', 'utf8');
const SECRET_PREFIX = 'vault1:';

let securityFile = '';
let metadata = null;
let vaultKey = null;

function clearVaultKey() {
  if (Buffer.isBuffer(vaultKey)) {
    try { vaultKey.fill(0); } catch {}
  }
  vaultKey = null;
}

function requirePassword(password) {
  const value = String(password || '');
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Le mot de passe principal doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`);
  }
  return value;
}

function decodeBase64(value, label, expectedLength = null) {
  const raw = String(value || '');
  if (!raw) throw new Error(`${label} manquant`);
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) throw new Error(`${label} invalide`);
  if (expectedLength != null && buffer.length !== expectedLength) {
    throw new Error(`${label} invalide`);
  }
  return buffer;
}

function validateMetadata(candidate) {
  if (!candidate || typeof candidate !== 'object') throw new Error('Configuration de sécurité invalide');
  if (candidate.format !== FORMAT || Number(candidate.version) !== VERSION) {
    throw new Error('Format du mot de passe principal inconnu');
  }
  if (candidate.enabled !== true) throw new Error('Configuration du mot de passe principal invalide');
  if (candidate.kdf !== KDF.name) throw new Error('Fonction de dérivation de clé non prise en charge');
  if (Number(candidate.N) !== KDF.N || Number(candidate.r) !== KDF.r || Number(candidate.p) !== KDF.p) {
    throw new Error('Paramètres de dérivation de clé non pris en charge');
  }
  decodeBase64(candidate.salt, 'Sel', 16);
  decodeBase64(candidate.iv, 'IV', 12);
  decodeBase64(candidate.authTag, 'Tag GCM', 16);
  decodeBase64(candidate.ciphertext, 'Enveloppe chiffrée');
  return {
    format: FORMAT,
    version: VERSION,
    enabled: true,
    kdf: KDF.name,
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    salt: String(candidate.salt),
    iv: String(candidate.iv),
    authTag: String(candidate.authTag),
    ciphertext: String(candidate.ciphertext),
  };
}

function loadMetadata() {
  if (!securityFile) throw new Error('Stockage du mot de passe principal non initialisé');
  if (!fs.existsSync(securityFile)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(securityFile, 'utf8'));
  } catch {
    throw new Error('Configuration du mot de passe principal illisible');
  }
  return validateMetadata(parsed);
}

function writeMetadataAtomic(value) {
  atomicFile.writeJsonAtomicSync(securityFile, value);
}

function deriveWrappingKey(password, salt, candidate = metadata) {
  const secret = requirePassword(password);
  const meta = candidate || {};
  return crypto.scryptSync(secret, salt, 32, {
    N: Number(meta.N) || KDF.N,
    r: Number(meta.r) || KDF.r,
    p: Number(meta.p) || KDF.p,
    maxmem: KDF.maxmem,
  });
}

function wrapVaultKey(key, password) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Clé de coffre invalide');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const base = {
    format: FORMAT,
    version: VERSION,
    enabled: true,
    kdf: KDF.name,
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
  };
  const wrappingKey = deriveWrappingKey(password, salt, base);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);
    cipher.setAAD(ENVELOPE_AAD);
    const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
    return {
      ...base,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  } finally {
    wrappingKey.fill(0);
  }
}

function unwrapVaultKey(candidate, password) {
  const meta = validateMetadata(candidate);
  const salt = decodeBase64(meta.salt, 'Sel', 16);
  const iv = decodeBase64(meta.iv, 'IV', 12);
  const authTag = decodeBase64(meta.authTag, 'Tag GCM', 16);
  const ciphertext = decodeBase64(meta.ciphertext, 'Enveloppe chiffrée');
  const wrappingKey = deriveWrappingKey(password, salt, meta);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, iv);
    decipher.setAAD(ENVELOPE_AAD);
    decipher.setAuthTag(authTag);
    const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (key.length !== 32) throw new Error('Clé de coffre restaurée invalide');
    return key;
  } catch {
    throw new Error('Mot de passe principal incorrect.');
  } finally {
    wrappingKey.fill(0);
  }
}

function init(baseDataDir) {
  clearVaultKey();
  securityFile = path.join(path.resolve(String(baseDataDir || '')), 'security.json');
  metadata = loadMetadata();
  return status();
}

function status() {
  return {
    enabled: Boolean(metadata?.enabled),
    locked: Boolean(metadata?.enabled) && !vaultKey,
    format: metadata?.format || FORMAT,
    version: metadata?.version || VERSION,
  };
}

function isEnabled() {
  return Boolean(metadata?.enabled);
}

function isLocked() {
  return isEnabled() && !vaultKey;
}

function enable(password) {
  if (!securityFile) throw new Error('Stockage du mot de passe principal non initialisé');
  if (isEnabled()) throw new Error('Le mot de passe principal est déjà activé');
  requirePassword(password);

  const key = crypto.randomBytes(32);
  const next = wrapVaultKey(key, password);
  writeMetadataAtomic(next);

  clearVaultKey();
  vaultKey = key;
  metadata = next;
  return status();
}

function unlock(password) {
  if (!isEnabled()) return status();
  const key = unwrapVaultKey(metadata, password);
  clearVaultKey();
  vaultKey = key;
  return status();
}

function lock() {
  clearVaultKey();
  return status();
}

function changePassword(currentPassword, newPassword) {
  if (!isEnabled()) throw new Error('Le mot de passe principal n’est pas activé');
  requirePassword(newPassword);

  const key = unwrapVaultKey(metadata, currentPassword);
  const next = wrapVaultKey(key, newPassword);
  try {
    writeMetadataAtomic(next);
  } catch (error) {
    key.fill(0);
    throw error;
  }

  clearVaultKey();
  vaultKey = key;
  metadata = next;
  return status();
}

function verify(password) {
  if (!isEnabled()) throw new Error('Le mot de passe principal n’est pas activé');
  const key = unwrapVaultKey(metadata, password);
  try {
    return key.length === 32;
  } finally {
    try { key.fill(0); } catch {}
  }
}

function disable(password) {
  if (!isEnabled()) return status();
  verify(password);
  if (!securityFile) throw new Error('Stockage du mot de passe principal non initialisé');

  try {
    fs.unlinkSync(securityFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    throw new Error('Configuration du mot de passe principal introuvable');
  }

  clearVaultKey();
  metadata = null;
  return status();
}

function requireUnlockedKey() {
  if (!isEnabled()) throw new Error('Le mot de passe principal n’est pas activé');
  if (!vaultKey) throw new Error('LibraMail est verrouillé');
  return vaultKey;
}

function secretAad(context) {
  return Buffer.from(`LibraMail-vault-secret-v1\0${String(context || '')}`, 'utf8');
}

function protectSecret(value, context) {
  const plain = String(value ?? '');
  if (!plain) return '';
  const key = requireUnlockedKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(secretAad(context));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plain, 'utf8')),
    cipher.final(),
  ]);
  return [
    SECRET_PREFIX.slice(0, -1),
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

function unprotectSecret(value, context) {
  const encoded = String(value || '');
  if (!encoded) return '';
  if (!encoded.startsWith(SECRET_PREFIX)) throw new Error('Secret protégé invalide');
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== 'vault1') throw new Error('Secret protégé invalide');

  const key = requireUnlockedKey();
  try {
    const iv = decodeBase64(parts[1], 'IV du secret', 12);
    const authTag = decodeBase64(parts[2], 'Tag du secret', 16);
    const ciphertext = decodeBase64(parts[3], 'Secret chiffré');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(secretAad(context));
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    if (/verrouillé/i.test(String(error?.message || ''))) throw error;
    throw new Error('Secret protégé illisible ou contexte incorrect');
  }
}

module.exports = {
  FORMAT,
  VERSION,
  MIN_PASSWORD_LENGTH,
  init,
  status,
  isEnabled,
  isLocked,
  enable,
  unlock,
  lock,
  changePassword,
  verify,
  disable,
  protectSecret,
  unprotectSecret,
};
