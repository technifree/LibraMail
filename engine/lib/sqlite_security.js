'use strict';

const fs = require('fs');
const path = require('path');

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

function chmodBestEffort(target, mode) {
  try { fs.chmodSync(target, mode); } catch {}
}

function hardenDirectory(directory) {
  const resolved = path.resolve(String(directory || ''));
  fs.mkdirSync(resolved, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodBestEffort(resolved, PRIVATE_DIR_MODE);
  return resolved;
}

function prepareDatabaseFile(file) {
  const resolved = path.resolve(String(file || ''));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  let fd = null;
  try {
    // Pré-créer le fichier principal en 0600 permet également à SQLite
    // d'hériter d'un mode restrictif pour ses artefacts WAL/SHM sous POSIX.
    fd = fs.openSync(resolved, 'a', PRIVATE_FILE_MODE);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  chmodBestEffort(resolved, PRIVATE_FILE_MODE);
  return resolved;
}

function hardenDatabaseArtifacts(file) {
  const resolved = path.resolve(String(file || ''));
  for (const target of [resolved, `${resolved}-wal`, `${resolved}-shm`]) {
    if (fs.existsSync(target)) chmodBestEffort(target, PRIVATE_FILE_MODE);
  }
}

module.exports = {
  PRIVATE_FILE_MODE,
  PRIVATE_DIR_MODE,
  hardenDirectory,
  prepareDatabaseFile,
  hardenDatabaseArtifacts,
};
