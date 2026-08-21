'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { simpleParser } = require('mailparser');

const db = require('./db');
const mailStore = require('./mail_store');

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const LOCAL_INBOX = 'Local/Imported';
const LOCAL_SENT = 'Local/Imported';

function normalizeMessageId(value) {
  return String(value || '').trim().toLowerCase();
}

function extractMessageIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) return [...new Set(value.flatMap(extractMessageIds))];
  const text = String(value);
  const bracketed = text.match(/<[^>]+>/g);
  const values = bracketed || text.split(/[\s,]+/).filter(Boolean);
  return [...new Set(values.map(item => item.trim().toLowerCase()).filter(Boolean))];
}

function addressList(parsedAddress) {
  return (parsedAddress?.value || [])
    .map(item => String(item?.address || '').trim())
    .filter(Boolean)
    .join(', ');
}

function buildThreadKey(parsed, row, account) {
  const references = extractMessageIds(parsed.references || parsed.headers?.get?.('references'));
  const inReplyTo = extractMessageIds(parsed.inReplyTo || parsed.headers?.get?.('in-reply-to'))[0] || null;
  const ownMessageId = extractMessageIds(row.message_id)[0] || null;
  const rootReference = references[0] || inReplyTo || ownMessageId;

  if (rootReference) {
    const existingThread = db.findThreadKeyByMessageIds([rootReference, inReplyTo, ...references]);
    return {
      threadKey: existingThread || `reference:${rootReference}`,
      inReplyTo,
      references,
    };
  }

  return {
    threadKey: db.fallbackThreadKey(
      row.subject,
      row.message_id || row.uid,
      row.from_addr,
      row.to_addr,
      account.id
    ),
    inReplyTo,
    references,
  };
}

function findDuplicate(accountId, messageId, sha256) {
  const normalizedId = normalizeMessageId(messageId);
  if (normalizedId) {
    const row = db.db.prepare(`
      SELECT id FROM messages
       WHERE account_id=? AND lower(COALESCE(message_id,''))=?
       LIMIT 1
    `).get(String(accountId), normalizedId);
    if (row) return { id: Number(row.id), reason: 'message-id' };
  }

  if (sha256) {
    const row = db.db.prepare(`
      SELECT id FROM messages
       WHERE account_id=? AND storage_sha256=?
       LIMIT 1
    `).get(String(accountId), String(sha256));
    if (row) return { id: Number(row.id), reason: 'sha256' };
  }
  return null;
}

function detectRole(parsed, account, requestedMode) {
  const mode = ['auto', 'inbox', 'sent'].includes(requestedMode) ? requestedMode : 'auto';
  if (mode !== 'auto') return mode;

  const own = String(account?.email || '').trim().toLowerCase();
  const from = (parsed.from?.value || [])
    .map(item => String(item?.address || '').trim().toLowerCase())
    .filter(Boolean);
  return own && from.includes(own) ? 'sent' : 'inbox';
}

function safeDate(parsed, stats) {
  const parsedDate = parsed?.date ? new Date(parsed.date).getTime() : NaN;
  if (Number.isFinite(parsedDate) && parsedDate > 0) return parsedDate;
  const mtime = Number(stats?.mtimeMs) || 0;
  return mtime > 0 ? mtime : Date.now();
}

async function importOne(account, filePath, mode) {
  const resolved = path.resolve(String(filePath || ''));
  if (path.extname(resolved).toLowerCase() !== '.eml') {
    throw new Error('Extension de fichier invalide (attendu : .eml)');
  }

  const stats = fs.statSync(resolved);
  if (!stats.isFile()) throw new Error('Le chemin sélectionné n’est pas un fichier');
  if (stats.size <= 0) throw new Error('Le fichier EML est vide');
  if (stats.size > MAX_FILE_BYTES) {
    throw new Error(`Le fichier EML dépasse ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} Mo`);
  }

  if (!mailStore.status().available) {
    throw new Error(mailStore.status().error || 'Stockage chiffré indisponible');
  }

  const raw = fs.readFileSync(resolved);
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex');

  // Le SHA est vérifié avant le parsing pour rendre un second import du même
  // fichier presque gratuit, même si le message ne possède pas de Message-ID.
  const shaDuplicate = findDuplicate(account.id, '', sha256);
  if (shaDuplicate) return { duplicate: true, reason: shaDuplicate.reason };

  const parsed = await simpleParser(raw, { skipImageLinks: true });
  const role = detectRole(parsed, account, mode);
  const folder = role === 'sent' ? LOCAL_SENT : LOCAL_INBOX;
  const messageId = parsed.messageId || null;

  const duplicate = findDuplicate(account.id, messageId, sha256);
  if (duplicate) return { duplicate: true, reason: duplicate.reason };

  const text = String(parsed.text || '').replace(/\s+/g, ' ').trim();
  const fromItem = parsed.from?.value?.[0] || {};
  const uid = db.nextLocalUid(account.id, folder);
  const row = {
    account_id: account.id,
    folder,
    folder_role: role,
    uid,
    message_id: messageId,
    subject: parsed.subject || '(sans objet)',
    from_name: fromItem.name || '',
    from_addr: fromItem.address || '',
    to_addr: addressList(parsed.to),
    date: safeDate(parsed, stats),
    snippet: mailStore.protectSnippet(account.id, text.slice(0, 160)),
    seen: 1,
    flagged: 0,
    answered: 0,
    has_attach: (parsed.attachments || []).length > 0 ? 1 : 0,
    size: raw.length,
    eml_path: '',
    is_spam: 0,
    thread_key: '',
    in_reply_to: null,
    references_json: '[]',
  };

  const thread = buildThreadKey(parsed, row, account);
  row.thread_key = thread.threadKey;
  row.in_reply_to = thread.inReplyTo;
  row.references_json = JSON.stringify(thread.references);

  let id = null;
  let descriptor = null;
  try {
    ({ id } = db.upsertMessage(row));
    descriptor = mailStore.storeMessage({ ...row, id }, raw);
    db.setMessageStorage(id, descriptor);
    db.indexBody(id, row, '', {
      secureTokens: mailStore.searchTokens(text),
    });
    return { imported: true, id, role, folder };
  } catch (error) {
    if (id != null) {
      try {
        mailStore.removeMessage({
          ...row,
          id,
          storage_kind: descriptor?.kind || '',
          storage_ref: descriptor?.ref || '',
          storage_sha256: descriptor?.sha256 || '',
          eml_path: descriptor?.emlPath || '',
        });
      } catch {}
      try { db.deleteMessage(id); } catch {}
    }
    throw error;
  }
}

async function importFiles({ account, paths = [], mode = 'auto', onProgress = null } = {}) {
  if (!account?.id) throw new Error('Compte de destination introuvable');
  const selected = [...new Set(
    (Array.isArray(paths) ? paths : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )];
  if (!selected.length) return { imported: 0, duplicates: 0, failed: 0, errors: [] };
  if (selected.length > MAX_FILES) {
    throw new Error(`Trop de fichiers sélectionnés (${selected.length}). Limite : ${MAX_FILES}.`);
  }

  const normalizedMode = ['auto', 'inbox', 'sent'].includes(mode) ? mode : 'auto';
  let imported = 0;
  let duplicates = 0;
  let failed = 0;
  const errors = [];

  for (let index = 0; index < selected.length; index++) {
    const file = selected[index];
    try {
      const result = await importOne(account, file, normalizedMode);
      if (result.duplicate) duplicates++;
      else if (result.imported) imported++;
    } catch (error) {
      failed++;
      if (errors.length < 20) {
        errors.push({
          name: path.basename(file),
          error: String(error?.message || error),
        });
      }
    }

    onProgress?.({
      completed: index + 1,
      total: selected.length,
      name: path.basename(file),
      imported,
      duplicates,
      failed,
    });

    if ((index + 1) % 10 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  return {
    imported,
    duplicates,
    failed,
    total: selected.length,
    errors,
  };
}

module.exports = {
  importFiles,
  importOne,
  detectRole,
  LOCAL_INBOX,
  LOCAL_SENT,
};
