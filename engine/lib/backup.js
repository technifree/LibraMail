/**
 * LibraMail — Sauvegarde/restauration complète au format ZIP.
 *
 * Aucun module npm supplémentaire n'est requis : le moteur écrit et lit les
 * entrées ZIP avec les API natives de Node.js. Les archives restent donc
 * utilisables avec les outils ZIP habituels, sans que la « portabilité »
 * dépende mystérieusement d'un paquet installé sur la machine d'origine.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const crypto = require('crypto');
const { Transform, Writable } = require('stream');
const { pipeline } = require('stream/promises');
const mailStore = require('./mail_store');

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const MAX_ENTRIES = 250000;
const MAX_CENTRAL_DIRECTORY = 256 * 1024 * 1024;
const MAX_UNCOMPRESSED_TOTAL = 500n * 1024n * 1024n * 1024n;
const FORMAT = 'libramail-backup';
const FORMAT_VERSION = 2;
const RUNTIME_DATA_FILES = new Set([
  'engine.log',
  'engine.stdout.log',
  'engine.stderr.log',
  'engine-startup.log',
  'index.db-wal',
  'index.db-shm',
]);

function isRuntimeDataPath(relative) {
  const normalized = String(relative || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const basename = path.posix.basename(normalized);
  return RUNTIME_DATA_FILES.has(normalized) || RUNTIME_DATA_FILES.has(basename);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function updateCrc(crc, chunk) {
  let value = crc >>> 0;
  for (let index = 0; index < chunk.length; index++) {
    value = CRC_TABLE[(value ^ chunk[index]) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

class CrcTransform extends Transform {
  constructor() {
    super();
    this.crc = UINT32_MAX;
    this.bytes = 0n;
  }

  _transform(chunk, encoding, callback) {
    this.crc = updateCrc(this.crc, chunk);
    this.bytes += BigInt(chunk.length);
    callback(null, chunk);
  }

  digest() {
    return (this.crc ^ UINT32_MAX) >>> 0;
  }
}

class CountTransform extends Transform {
  constructor() {
    super();
    this.bytes = 0n;
  }

  _transform(chunk, encoding, callback) {
    this.bytes += BigInt(chunk.length);
    callback(null, chunk);
  }
}

function passthroughSink(output) {
  return new Writable({
    write(chunk, encoding, callback) {
      if (output.write(chunk)) callback();
      else output.once('drain', callback);
    },
  });
}

function writeBuffer(output, buffer) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      output.off('error', onError);
      reject(error);
    };
    output.once('error', onError);
    output.write(buffer, error => {
      output.off('error', onError);
      if (error) reject(error);
      else resolve();
    });
  });
}

function dosDateTime(dateValue) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue || Date.now());
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const dosTime = ((date.getHours() & 0x1f) << 11)
    | ((date.getMinutes() & 0x3f) << 5)
    | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9)
    | (((date.getMonth() + 1) & 0x0f) << 5)
    | (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function normalizeEntryName(value) {
  const name = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const normalized = path.posix.normalize(name);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Chemin ZIP invalide : ${value}`);
  }
  if (normalized.includes('\0')) throw new Error('Nom de fichier ZIP invalide');
  return normalized;
}

function safeNumber(bigint, label) {
  if (bigint > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} dépasse la taille prise en charge`);
  }
  return Number(bigint);
}

function zip64Extra(values) {
  const payload = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => payload.writeBigUInt64LE(BigInt(value), index * 8));
  const extra = Buffer.alloc(4 + payload.length);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(payload.length, 2);
  payload.copy(extra, 4);
  return extra;
}

async function createZip(targetPath, entries, { onProgress } = {}) {
  const output = fs.createWriteStream(targetPath, { flags: 'w', mode: 0o600 });
  const centralEntries = [];
  let offset = 0n;
  let completed = 0;

  try {
    for (const source of entries) {
      const name = normalizeEntryName(source.name);
      const nameBuffer = Buffer.from(name, 'utf8');
      if (nameBuffer.length > UINT16_MAX) throw new Error(`Nom trop long dans la sauvegarde : ${name}`);
      const stat = source.stat || await fsp.stat(source.path);
      if (!stat.isFile()) continue;
      const zip64File = BigInt(stat.size) >= BigInt(UINT32_MAX) - 65536n;

      const localOffset = offset;
      const { dosTime, dosDate } = dosDateTime(stat.mtime);
      const flags = 0x0808; // UTF-8 + data descriptor
      const method = 8; // Deflate
      const localExtra = zip64File ? zip64Extra([BigInt(stat.size), 0n]) : Buffer.alloc(0);
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(zip64File ? 45 : 20, 4);
      localHeader.writeUInt16LE(flags, 6);
      localHeader.writeUInt16LE(method, 8);
      localHeader.writeUInt16LE(dosTime, 10);
      localHeader.writeUInt16LE(dosDate, 12);
      localHeader.writeUInt32LE(0, 14);
      localHeader.writeUInt32LE(zip64File ? UINT32_MAX : 0, 18);
      localHeader.writeUInt32LE(zip64File ? UINT32_MAX : 0, 22);
      localHeader.writeUInt16LE(nameBuffer.length, 26);
      localHeader.writeUInt16LE(localExtra.length, 28);

      await writeBuffer(output, localHeader);
      await writeBuffer(output, nameBuffer);
      if (localExtra.length) await writeBuffer(output, localExtra);
      offset += BigInt(localHeader.length + nameBuffer.length + localExtra.length);

      const crc = new CrcTransform();
      const compressed = new CountTransform();
      await pipeline(
        fs.createReadStream(source.path),
        crc,
        zlib.createDeflateRaw({ level: 6 }),
        compressed,
        passthroughSink(output),
      );
      offset += compressed.bytes;

      const needsZip64Sizes = zip64File
        || crc.bytes > BigInt(UINT32_MAX)
        || compressed.bytes > BigInt(UINT32_MAX);
      const descriptor = Buffer.alloc(needsZip64Sizes ? 24 : 16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc.digest(), 4);
      if (needsZip64Sizes) {
        descriptor.writeBigUInt64LE(compressed.bytes, 8);
        descriptor.writeBigUInt64LE(crc.bytes, 16);
      } else {
        descriptor.writeUInt32LE(Number(compressed.bytes), 8);
        descriptor.writeUInt32LE(Number(crc.bytes), 12);
      }
      await writeBuffer(output, descriptor);
      offset += BigInt(descriptor.length);

      centralEntries.push({
        nameBuffer,
        name,
        flags,
        method,
        dosTime,
        dosDate,
        crc: crc.digest(),
        compressedSize: compressed.bytes,
        uncompressedSize: crc.bytes,
        localOffset,
        mode: Number(stat.mode) || 0o100600,
        zip64Sizes: needsZip64Sizes,
      });
      completed++;
      onProgress?.({ completed, total: entries.length, name });
    }

    const centralOffset = offset;
    for (const entry of centralEntries) {
      const needsZip64Offset = entry.localOffset > BigInt(UINT32_MAX);
      const zip64Values = [];
      if (entry.zip64Sizes) zip64Values.push(entry.uncompressedSize, entry.compressedSize);
      if (needsZip64Offset) zip64Values.push(entry.localOffset);
      const extra = zip64Values.length ? zip64Extra(zip64Values) : Buffer.alloc(0);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(0x031e, 4); // Unix, ZIP 3.0
      central.writeUInt16LE((needsZip64Offset || entry.zip64Sizes) ? 45 : 20, 6);
      central.writeUInt16LE(entry.flags, 8);
      central.writeUInt16LE(entry.method, 10);
      central.writeUInt16LE(entry.dosTime, 12);
      central.writeUInt16LE(entry.dosDate, 14);
      central.writeUInt32LE(entry.crc, 16);
      central.writeUInt32LE(entry.zip64Sizes ? UINT32_MAX : Number(entry.compressedSize), 20);
      central.writeUInt32LE(entry.zip64Sizes ? UINT32_MAX : Number(entry.uncompressedSize), 24);
      central.writeUInt16LE(entry.nameBuffer.length, 28);
      central.writeUInt16LE(extra.length, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE((((entry.mode & 0xffff) << 16) >>> 0), 38);
      central.writeUInt32LE(needsZip64Offset ? UINT32_MAX : Number(entry.localOffset), 42);
      await writeBuffer(output, central);
      await writeBuffer(output, entry.nameBuffer);
      if (extra.length) await writeBuffer(output, extra);
      offset += BigInt(central.length + entry.nameBuffer.length + extra.length);
    }

    const centralSize = offset - centralOffset;
    const count = BigInt(centralEntries.length);
    const needsZip64 = count > BigInt(UINT16_MAX)
      || centralOffset > BigInt(UINT32_MAX)
      || centralSize > BigInt(UINT32_MAX);

    if (needsZip64) {
      const zip64Offset = offset;
      const eocd64 = Buffer.alloc(56);
      eocd64.writeUInt32LE(0x06064b50, 0);
      eocd64.writeBigUInt64LE(44n, 4);
      eocd64.writeUInt16LE(0x031e, 12);
      eocd64.writeUInt16LE(45, 14);
      eocd64.writeUInt32LE(0, 16);
      eocd64.writeUInt32LE(0, 20);
      eocd64.writeBigUInt64LE(count, 24);
      eocd64.writeBigUInt64LE(count, 32);
      eocd64.writeBigUInt64LE(centralSize, 40);
      eocd64.writeBigUInt64LE(centralOffset, 48);
      await writeBuffer(output, eocd64);
      offset += BigInt(eocd64.length);

      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(zip64Offset, 8);
      locator.writeUInt32LE(1, 16);
      await writeBuffer(output, locator);
      offset += BigInt(locator.length);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(needsZip64 ? UINT16_MAX : centralEntries.length, 8);
    eocd.writeUInt16LE(needsZip64 ? UINT16_MAX : centralEntries.length, 10);
    eocd.writeUInt32LE(needsZip64 ? UINT32_MAX : Number(centralSize), 12);
    eocd.writeUInt32LE(needsZip64 ? UINT32_MAX : Number(centralOffset), 16);
    eocd.writeUInt16LE(0, 20);
    await writeBuffer(output, eocd);
    offset += BigInt(eocd.length);

    await new Promise((resolve, reject) => {
      output.once('error', reject);
      output.end(resolve);
    });
    return { entries: centralEntries.length, size: safeNumber(offset, 'Archive ZIP') };
  } catch (error) {
    output.destroy();
    await fsp.rm(targetPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, safeNumber(position, 'Position ZIP'));
  if (bytesRead !== length) throw new Error('Archive ZIP tronquée');
  return buffer;
}

function parseZip64Extra(extra, needs) {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    const start = cursor + 4;
    const end = start + size;
    if (end > extra.length) throw new Error('Champ ZIP supplémentaire invalide');
    if (id === 0x0001) {
      let offset = start;
      const result = {};
      for (const key of needs) {
        if (offset + 8 > end) throw new Error('Champ ZIP64 incomplet');
        result[key] = extra.readBigUInt64LE(offset);
        offset += 8;
      }
      return result;
    }
    cursor = end;
  }
  return {};
}

async function readCentralDirectory(zipPath) {
  const handle = await fsp.open(zipPath, 'r');
  try {
    const stat = await handle.stat();
    const fileSize = BigInt(stat.size);
    if (fileSize < 22n) throw new Error('Ce fichier n’est pas une archive ZIP valide');
    const tailSize = Math.min(stat.size, 131072);
    const tailStart = stat.size - tailSize;
    const tail = await readAt(handle, BigInt(tailStart), tailSize);
    let eocdIndex = -1;
    for (let index = tail.length - 22; index >= 0; index--) {
      if (tail.readUInt32LE(index) === 0x06054b50) {
        const commentLength = tail.readUInt16LE(index + 20);
        if (index + 22 + commentLength === tail.length) {
          eocdIndex = index;
          break;
        }
      }
    }
    if (eocdIndex < 0) throw new Error('Fin de l’archive ZIP introuvable');

    const eocdOffset = BigInt(tailStart + eocdIndex);
    const eocd = tail.subarray(eocdIndex, eocdIndex + 22);
    let entriesCount = BigInt(eocd.readUInt16LE(10));
    let centralSize = BigInt(eocd.readUInt32LE(12));
    let centralOffset = BigInt(eocd.readUInt32LE(16));

    if (entriesCount === BigInt(UINT16_MAX)
        || centralSize === BigInt(UINT32_MAX)
        || centralOffset === BigInt(UINT32_MAX)) {
      if (eocdOffset < 20n) throw new Error('Localisateur ZIP64 absent');
      const locator = await readAt(handle, eocdOffset - 20n, 20);
      if (locator.readUInt32LE(0) !== 0x07064b50) throw new Error('Localisateur ZIP64 invalide');
      const eocd64Offset = locator.readBigUInt64LE(8);
      const eocd64 = await readAt(handle, eocd64Offset, 56);
      if (eocd64.readUInt32LE(0) !== 0x06064b50) throw new Error('En-tête ZIP64 invalide');
      entriesCount = eocd64.readBigUInt64LE(32);
      centralSize = eocd64.readBigUInt64LE(40);
      centralOffset = eocd64.readBigUInt64LE(48);
    }

    if (entriesCount > BigInt(MAX_ENTRIES)) throw new Error('L’archive contient trop de fichiers');
    if (centralSize > BigInt(MAX_CENTRAL_DIRECTORY)) throw new Error('Répertoire central ZIP anormalement volumineux');
    if (centralOffset + centralSize > fileSize) throw new Error('Répertoire central ZIP hors limites');

    const central = await readAt(handle, centralOffset, safeNumber(centralSize, 'Répertoire ZIP'));
    const entries = [];
    let cursor = 0;
    let uncompressedTotal = 0n;

    for (let index = 0; index < Number(entriesCount); index++) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) {
        throw new Error('Répertoire central ZIP endommagé');
      }
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const crc = central.readUInt32LE(cursor + 16);
      const compressed32 = central.readUInt32LE(cursor + 20);
      const uncompressed32 = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const externalAttributes = central.readUInt32LE(cursor + 38);
      const localOffset32 = central.readUInt32LE(cursor + 42);
      const end = cursor + 46 + nameLength + extraLength + commentLength;
      if (end > central.length) throw new Error('Entrée ZIP tronquée');
      const nameBuffer = central.subarray(cursor + 46, cursor + 46 + nameLength);
      const name = normalizeEntryName(nameBuffer.toString((flags & 0x0800) ? 'utf8' : 'latin1'));
      const extra = central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
      const zip64Needs = [];
      if (uncompressed32 === UINT32_MAX) zip64Needs.push('uncompressedSize');
      if (compressed32 === UINT32_MAX) zip64Needs.push('compressedSize');
      if (localOffset32 === UINT32_MAX) zip64Needs.push('localOffset');
      const zip64 = parseZip64Extra(extra, zip64Needs);
      const uncompressedSize = uncompressed32 === UINT32_MAX ? zip64.uncompressedSize : BigInt(uncompressed32);
      const compressedSize = compressed32 === UINT32_MAX ? zip64.compressedSize : BigInt(compressed32);
      const localOffset = localOffset32 === UINT32_MAX ? zip64.localOffset : BigInt(localOffset32);
      if (uncompressedSize == null || compressedSize == null || localOffset == null) {
        throw new Error(`Informations ZIP64 manquantes pour ${name}`);
      }
      if (flags & 0x0001) throw new Error('Les sauvegardes ZIP chiffrées ne sont pas prises en charge');
      if (![0, 8].includes(method)) throw new Error(`Méthode de compression non prise en charge pour ${name}`);
      if (localOffset >= fileSize) throw new Error(`Position ZIP invalide pour ${name}`);
      const unixMode = (externalAttributes >>> 16) & 0xffff;
      if ((unixMode & 0xf000) === 0xa000) throw new Error(`Lien symbolique interdit dans l’archive : ${name}`);

      uncompressedTotal += uncompressedSize;
      if (uncompressedTotal > MAX_UNCOMPRESSED_TOTAL) throw new Error('La sauvegarde décompressée est anormalement volumineuse');
      entries.push({
        name,
        flags,
        method,
        crc,
        compressedSize,
        uncompressedSize,
        localOffset,
        isDirectory: name.endsWith('/'),
      });
      cursor = end;
    }

    return { entries, fileSize, uncompressedTotal };
  } finally {
    await handle.close();
  }
}

async function entryDataOffset(zipPath, entry) {
  const handle = await fsp.open(zipPath, 'r');
  try {
    const local = await readAt(handle, entry.localOffset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`En-tête local ZIP invalide pour ${entry.name}`);
    const nameLength = local.readUInt16LE(26);
    const extraLength = local.readUInt16LE(28);
    return entry.localOffset + BigInt(30 + nameLength + extraLength);
  } finally {
    await handle.close();
  }
}

async function extractEntry(zipPath, entry, targetPath) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  if (entry.uncompressedSize === 0n) {
    await fsp.writeFile(targetPath, Buffer.alloc(0), { mode: 0o600 });
    if (entry.crc !== 0) throw new Error(`Somme de contrôle invalide pour ${entry.name}`);
    return;
  }
  const dataOffset = await entryDataOffset(zipPath, entry);
  const end = dataOffset + entry.compressedSize - 1n;
  const verifier = new CrcTransform();
  const input = fs.createReadStream(zipPath, {
    start: safeNumber(dataOffset, 'Position ZIP'),
    end: safeNumber(end, 'Position ZIP'),
  });
  const streams = [input];
  if (entry.method === 8) streams.push(zlib.createInflateRaw());
  streams.push(verifier, fs.createWriteStream(targetPath, { flags: 'w', mode: 0o600 }));
  await pipeline(...streams);
  if (verifier.bytes !== entry.uncompressedSize || verifier.digest() !== entry.crc) {
    await fsp.rm(targetPath, { force: true }).catch(() => {});
    throw new Error(`Contrôle d’intégrité échoué pour ${entry.name}`);
  }
}

async function readEntryBuffer(zipPath, entry, maxBytes = 8 * 1024 * 1024) {
  if (entry.uncompressedSize > BigInt(maxBytes)) throw new Error(`Entrée trop volumineuse : ${entry.name}`);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'libramail-entry-'));
  const target = path.join(tempDir, 'entry');
  try {
    await extractEntry(zipPath, entry, target);
    return await fsp.readFile(target);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function inspectArchive(sourcePath) {
  const source = path.resolve(String(sourcePath || ''));
  const stat = await fsp.stat(source).catch(() => null);
  if (!stat?.isFile()) throw new Error('Fichier de sauvegarde introuvable');
  const directory = await readCentralDirectory(source);
  const byName = new Map(directory.entries.map(entry => [entry.name, entry]));
  const manifestEntry = byName.get('manifest.json');
  if (!manifestEntry) throw new Error('Cette archive ne contient pas de manifeste LibraMail');
  let manifest;
  try {
    manifest = JSON.parse((await readEntryBuffer(source, manifestEntry)).toString('utf8'));
  } catch (error) {
    throw new Error(`Manifeste de sauvegarde invalide : ${error.message}`);
  }
  const formatVersion = Number(manifest?.formatVersion);
  if (manifest?.format !== FORMAT || ![1, FORMAT_VERSION].includes(formatVersion)) {
    throw new Error('Cette archive n’est pas une sauvegarde LibraMail compatible');
  }
  for (const required of ['data/accounts.json', 'data/config.json', 'data/index.db']) {
    if (!byName.has(required)) throw new Error(`Sauvegarde incomplète : ${required} est absent`);
  }
  return {
    source,
    manifest,
    entries: directory.entries,
    fileSize: Number(directory.fileSize),
    uncompressedSize: safeNumber(directory.uncompressedTotal, 'Sauvegarde décompressée'),
  };
}

async function extractArchive(sourcePath, targetRoot, { onProgress } = {}) {
  const inspection = await inspectArchive(sourcePath);
  await fsp.mkdir(targetRoot, { recursive: true });
  let completed = 0;
  const dataEntries = inspection.entries.filter(entry => {
    if (!entry.name.startsWith('data/') || entry.isDirectory) return false;
    const relative = entry.name.slice('data/'.length);
    return !isRuntimeDataPath(relative);
  });
  for (const entry of dataEntries) {
    const relative = entry.name.slice('data/'.length);
    const safeRelative = normalizeEntryName(relative);
    const destination = path.resolve(targetRoot, 'data', safeRelative);
    const allowedRoot = path.resolve(targetRoot, 'data') + path.sep;
    if (!destination.startsWith(allowedRoot)) throw new Error(`Chemin interdit dans la sauvegarde : ${entry.name}`);
    await extractEntry(inspection.source, entry, destination);
    completed++;
    onProgress?.({ completed, total: dataEntries.length, name: entry.name });
  }
  return { ...inspection, dataDir: path.join(targetRoot, 'data') };
}

function shouldExcludeDataPath(relative) {
  const normalized = String(relative || '').replace(/\\/g, '/');
  const basename = path.posix.basename(normalized);
  if (normalized === 'index.db' || isRuntimeDataPath(normalized)) return true;
  if (basename.endsWith('.tmp') || basename.endsWith('.lock') || basename.endsWith('-wal') || basename.endsWith('-shm')) return true;
  return false;
}

async function walkFiles(root, relative = '') {
  const output = [];
  const directory = path.join(root, relative);
  const items = await fsp.readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  items.sort((a, b) => a.name.localeCompare(b.name));
  for (const item of items) {
    const childRelative = relative ? path.join(relative, item.name) : item.name;
    if (shouldExcludeDataPath(childRelative)) continue;
    const childPath = path.join(root, childRelative);
    if (item.isDirectory()) output.push(...await walkFiles(root, childRelative));
    else if (item.isFile()) output.push({ relative: childRelative, path: childPath, stat: await fsp.stat(childPath) });
  }
  return output;
}

function summaryFromDatabase(database, dataFiles, coverage = null) {
  const scalar = sql => {
    try { return Number(database.prepare(sql).pluck().get()) || 0; } catch { return 0; }
  };
  const checked = coverage || mailStore.verifyIndexCoverage(database);
  return {
    accounts: 0,
    messages: scalar('SELECT COUNT(*) FROM messages'),
    unread: scalar('SELECT COUNT(*) FROM messages WHERE seen=0'),
    contacts: scalar('SELECT COUNT(*) FROM contacts'),
    labels: scalar('SELECT COUNT(*) FROM labels'),
    encryptedMessages: Number(checked.encrypted) || 0,
    legacyMessages: Number(checked.legacy) || 0,
    mailStoreFiles: dataFiles.filter(file => file.relative.replace(/\\/g, '/').startsWith('mailstore/') && file.relative.endsWith('.db')).length,
    mailFiles: dataFiles.filter(file => file.relative.replace(/\\/g, '/').startsWith('mail/') && file.relative.endsWith('.eml')).length,
  };
}

async function exportArchive({ dataDir, database, targetPath, appVersion, password = '', onProgress }) {
  const target = path.resolve(String(targetPath || ''));
  if (!target.toLowerCase().endsWith('.zip')) throw new Error('Le fichier de sauvegarde doit porter l’extension .zip');
  const resolvedData = path.resolve(dataDir);
  if (target === resolvedData || target.startsWith(resolvedData + path.sep)) {
    throw new Error('La sauvegarde doit être enregistrée en dehors du dossier data de LibraMail');
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'libramail-backup-'));
  const snapshotPath = path.join(tempDir, 'index.db');
  const manifestPath = path.join(tempDir, 'manifest.json');
  const temporaryTarget = `${target}.part-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

  try {
    onProgress?.({ step: 'prepare', completed: 0, total: 1, name: '' });
    mailStore.checkpointAll();
    await database.backup(snapshotPath);
    const accountsPath = path.join(resolvedData, 'accounts.json');
    const configPath = path.join(resolvedData, 'config.json');
    if (!fs.existsSync(accountsPath)) await fsp.writeFile(accountsPath, '[]\n', { mode: 0o600 });
    if (!fs.existsSync(configPath)) await fsp.writeFile(configPath, '{}\n', { mode: 0o600 });
    const dataFiles = await walkFiles(resolvedData);
    const safeAccountsPath = path.join(tempDir, 'accounts.json');
    let safeAccounts = [];
    try {
      safeAccounts = JSON.parse(await fsp.readFile(accountsPath, 'utf8'));
      if (!Array.isArray(safeAccounts)) safeAccounts = [];
    } catch { safeAccounts = []; }
    safeAccounts = safeAccounts.map(account => {
      const copy = JSON.parse(JSON.stringify(account || {}));
      if (copy.imap) delete copy.imap.pass;
      if (copy.pop3) delete copy.pop3.pass;
      if (copy.smtp) delete copy.smtp.pass;
      return copy;
    });
    await fsp.writeFile(safeAccountsPath, JSON.stringify(safeAccounts, null, 2) + '\n', { mode: 0o600 });

    const coverage = mailStore.verifyIndexCoverage(database, resolvedData);
    const summary = summaryFromDatabase(database, dataFiles, coverage);
    try {
      summary.accounts = JSON.parse(await fsp.readFile(accountsPath, 'utf8')).length || 0;
    } catch {}
    if (!coverage.complete) {
      throw new Error(`Sauvegarde incomplète refusée : ${coverage.missingEncrypted.length} message(s) chiffré(s) et ${coverage.missingLegacy.length} ancien(s) message(s) sont introuvables.`);
    }
    let keyEnvelope = null;
    if (summary.encryptedMessages > 0) keyEnvelope = mailStore.exportKeyEnvelope(password);
    const manifest = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      appVersion: String(appVersion || ''),
      createdAt: new Date().toISOString(),
      platform: process.platform,
      architecture: process.arch,
      includesCredentials: false,
      summary,
      mailStoreEncryption: {
        enabled: summary.encryptedMessages > 0,
        algorithm: summary.encryptedMessages > 0 ? 'AES-256-GCM' : null,
        requiresPassword: summary.encryptedMessages > 0,
        keyEnvelope,
      },
    };
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

    const entries = [
      { name: 'manifest.json', path: manifestPath },
      { name: 'data/index.db', path: snapshotPath },
      { name: 'data/accounts.json', path: safeAccountsPath },
      ...dataFiles
        .filter(file => file.relative.replace(/\\/g, '/') !== 'accounts.json')
        .map(file => ({
          name: `data/${file.relative.replace(/\\/g, '/')}`,
          path: file.path,
          stat: file.stat,
        })),
    ];
    onProgress?.({ step: 'prepare', completed: 1, total: 1, name: '' });
    const result = await createZip(temporaryTarget, entries, {
      onProgress: progress => onProgress?.({ ...progress, step: 'archive' }),
    });
    await fsp.rm(target, { force: true });
    await fsp.rename(temporaryTarget, target);
    return {
      targetPath: target,
      archiveSize: result.size,
      fileCount: result.entries,
      manifest,
    };
  } finally {
    await fsp.rm(temporaryTarget, { force: true }).catch(() => {});
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function validateExtractedData(dataDir, { manifest = null, password = '' } = {}) {
  const accountsPath = path.join(dataDir, 'accounts.json');
  const configPath = path.join(dataDir, 'config.json');
  const databasePath = path.join(dataDir, 'index.db');
  let accounts;
  let config;
  try { accounts = JSON.parse(await fsp.readFile(accountsPath, 'utf8')); }
  catch (error) { throw new Error(`accounts.json invalide : ${error.message}`); }
  try { config = JSON.parse(await fsp.readFile(configPath, 'utf8')); }
  catch (error) { throw new Error(`config.json invalide : ${error.message}`); }
  if (!Array.isArray(accounts)) throw new Error('accounts.json ne contient pas une liste de comptes');
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config.json ne contient pas des paramètres valides');

  const Database = require('better-sqlite3');
  const validationDb = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = validationDb.pragma('integrity_check', { simple: true });
    if (String(integrity).toLowerCase() !== 'ok') throw new Error(`Base SQLite endommagée : ${integrity}`);
    const tables = new Set(validationDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all());
    if (!tables.has('messages')) throw new Error('La base sauvegardée ne contient pas la table des messages');
    const coverage = mailStore.verifyIndexCoverage(validationDb, dataDir);
    if (!coverage.complete) {
      throw new Error(`Sauvegarde incomplète : ${coverage.missingEncrypted.length} message(s) chiffré(s) et ${coverage.missingLegacy.length} ancien(s) message(s) sont introuvables.`);
    }
    const encryption = manifest?.mailStoreEncryption || {};
    if (coverage.encrypted > 0) {
      if (!encryption?.keyEnvelope) throw new Error('La sauvegarde contient des messages chiffrés mais aucune clé de récupération.');
      mailStore.unwrapKeyEnvelope(encryption.keyEnvelope, password);
    }
  } finally {
    validationDb.close();
  }
  return { accounts, config };
}

module.exports = {
  FORMAT,
  FORMAT_VERSION,
  createZip,
  readCentralDirectory,
  inspectArchive,
  extractArchive,
  exportArchive,
  validateExtractedData,
};
