/**
 * LibraMail — pièces jointes préparées pour la rédaction.
 * Stockage dans le répertoire de données du moteur, jamais dans /opt ou NL_PATH.
 * Les pièces jointes transférées sont extraites du message MIME original.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_FORWARD_ATTACHMENTS = 100;

function directory(dataDir) {
  const root = path.join(path.resolve(dataDir), 'compose-attachments');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function safeFilename(value, index) {
  let filename = String(value || `piece-jointe-${index + 1}`)
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '').trim();
  if (!filename) filename = `piece-jointe-${index + 1}`;
  if (filename.length > 160) {
    const ext = path.extname(filename);
    const suffix = ext.length < 16 ? ext : '';
    filename = filename.slice(0, 160 - suffix.length) + suffix;
  }
  return filename;
}

function stageForward(dataDir, parsedAttachments, indexes) {
  if (!Array.isArray(parsedAttachments) || !Array.isArray(indexes) ||
      indexes.length > MAX_FORWARD_ATTACHMENTS) {
    throw new Error('Liste de pièces jointes invalide');
  }
  const root = directory(dataDir);
  const written = [];
  const output = [];
  const seen = new Set();
  try {
    for (const raw of indexes) {
      if (!Number.isInteger(raw) || raw < 0 || raw >= parsedAttachments.length || seen.has(raw)) {
        throw new Error('Indice de pièce jointe invalide');
      }
      seen.add(raw);
      const attachment = parsedAttachments[raw];
      if (!attachment || !Buffer.isBuffer(attachment.content)) {
        throw new Error(`Contenu de pièce jointe indisponible : ${raw}`);
      }
      const filename = safeFilename(attachment.filename, raw);
      const target = path.join(root, `${crypto.randomUUID()}-${filename}`);
      fs.writeFileSync(target, attachment.content, { flag: 'wx', mode: 0o600 });
      written.push(target);
      output.push({ filename, path: target, size: attachment.content.length, managedCopy: true });
    }
    return output;
  } catch (error) {
    for (const target of written) {
      try { fs.rmSync(target, { force: true }); } catch {}
    }
    throw error;
  }
}

function cleanupPrepared(dataDir, attachments) {
  if (!Array.isArray(attachments)) return 0;
  let root;
  try {
    root = path.resolve(directory(dataDir));
  } catch (error) {
    console.warn('[LibraMail] Nettoyage des pièces jointes indisponible :', error.message);
    return 0;
  }
  let removed = 0;
  for (const item of attachments) {
    if (item?.managedCopy !== true || typeof item.path !== 'string') continue;
    const target = path.resolve(item.path);
    if (!target.startsWith(root + path.sep)) continue;
    try {
      const stat = fs.lstatSync(target);
      if (stat.isFile() || stat.isSymbolicLink()) {
        fs.unlinkSync(target);
        removed++;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[LibraMail] Nettoyage pièce jointe :', error.message);
    }
  }
  return removed;
}

module.exports = { directory, safeFilename, stageForward, cleanupPrepared };
