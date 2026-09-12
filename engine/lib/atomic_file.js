'use strict';

const fs = require('fs');
const path = require('path');

const RETRYABLE_RENAME_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);
let tempCounter = 0;

function tempPathFor(target) {
  tempCounter = (tempCounter + 1) >>> 0;
  const resolved = path.resolve(String(target || ''));
  const directory = path.dirname(resolved);
  const basename = path.basename(resolved);
  return path.join(
    directory,
    `.${basename}.tmp-${process.pid}-${Date.now()}-${tempCounter}`
  );
}

function chmodBestEffortSync(target, mode) {
  try { fs.chmodSync(target, mode); } catch {}
}

async function chmodBestEffort(target, mode) {
  try { await fs.promises.chmod(target, mode); } catch {}
}

function fsyncDirectorySync(directory) {
  if (process.platform === 'win32') return;
  let fd = null;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

async function fsyncDirectory(directory) {
  if (process.platform === 'win32') return;
  let handle = null;
  try {
    handle = await fs.promises.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    if (handle) {
      try { await handle.close(); } catch {}
    }
  }
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

function renameAtomicSync(source, target) {
  const attempts = process.platform === 'win32' ? 5 : 1;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.renameSync(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (
        process.platform !== 'win32'
        || !RETRYABLE_RENAME_ERRORS.has(error?.code)
        || attempt === attempts - 1
      ) {
        throw error;
      }
      sleepSync(20 * (attempt + 1));
    }
  }

  throw lastError;
}

async function renameAtomic(source, target) {
  const attempts = process.platform === 'win32' ? 5 : 1;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.promises.rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (
        process.platform !== 'win32'
        || !RETRYABLE_RENAME_ERRORS.has(error?.code)
        || attempt === attempts - 1
      ) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }

  throw lastError;
}

function writeFileAtomicSync(target, data, { encoding = 'utf8', mode = 0o600 } = {}) {
  const resolved = path.resolve(String(target || ''));
  const directory = path.dirname(resolved);

  fs.mkdirSync(directory, { recursive: true });

  const temp = tempPathFor(resolved);
  let fd = null;
  let renamed = false;

  try {
    fd = fs.openSync(temp, 'wx', mode);
    fs.writeFileSync(fd, data, { encoding });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    chmodBestEffortSync(temp, mode);
    renameAtomicSync(temp, resolved);
    renamed = true;

    chmodBestEffortSync(resolved, mode);
    fsyncDirectorySync(directory);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    if (!renamed) {
      try { fs.rmSync(temp, { force: true }); } catch {}
    }
    throw error;
  }

  return resolved;
}

async function writeFileAtomic(target, data, { encoding = 'utf8', mode = 0o600 } = {}) {
  const resolved = path.resolve(String(target || ''));
  const directory = path.dirname(resolved);

  await fs.promises.mkdir(directory, { recursive: true });

  const temp = tempPathFor(resolved);
  let handle = null;
  let renamed = false;

  try {
    handle = await fs.promises.open(temp, 'wx', mode);
    await handle.writeFile(data, { encoding });
    await handle.sync();
    await handle.close();
    handle = null;

    await chmodBestEffort(temp, mode);
    await renameAtomic(temp, resolved);
    renamed = true;

    await chmodBestEffort(resolved, mode);
    await fsyncDirectory(directory);
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch {}
    }
    if (!renamed) {
      try { await fs.promises.rm(temp, { force: true }); } catch {}
    }
    throw error;
  }

  return resolved;
}

function encodeJson(value, { space = 2, newline = true } = {}) {
  const encoded = JSON.stringify(value, null, space);
  if (encoded === undefined) {
    throw new TypeError('Valeur JSON non sérialisable');
  }
  return newline ? `${encoded}\n` : encoded;
}

function writeJsonAtomicSync(target, value, options = {}) {
  return writeFileAtomicSync(target, encodeJson(value, options), options);
}

async function writeJsonAtomic(target, value, options = {}) {
  return writeFileAtomic(target, encodeJson(value, options), options);
}

module.exports = {
  writeFileAtomicSync,
  writeFileAtomic,
  writeJsonAtomicSync,
  writeJsonAtomic,
};
