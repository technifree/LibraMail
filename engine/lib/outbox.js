/**
 * LibraMail 0.2.24 — brouillons et envois différés.
 * Stockage SQLite local, pièces jointes copiées dans data/outbox/.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let database = null;
let dataRoot = '';
let attachmentRoot = '';

function now() { return Date.now(); }

function ensureReady() {
  if (!database) throw new Error('Gestionnaire de brouillons non initialisé');
}

function parseJson(value, fallback) {
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

function sanitizeFilename(value, index = 0) {
  const source = path.basename(String(value || `piece-jointe-${index + 1}`));
  const cleaned = source.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return cleaned || `piece-jointe-${index + 1}`;
}

function normalizeAttachments(value) {
  return (Array.isArray(value) ? value : [])
    .map((item, index) => ({
      filename: sanitizeFilename(item?.filename || item?.path, index),
      path: String(item?.path || '').trim(),
      contentType: item?.contentType ? String(item.contentType) : undefined,
    }))
    .filter(item => item.path);
}

function persistedAttachmentPath(absolutePath) {
  const relative = path.relative(dataRoot, absolutePath);
  return relative.split(path.sep).join('/');
}

function resolveAttachmentPath(value) {
  const stored = String(value || '').trim();
  if (!stored) return '';
  const absoluteLike = path.isAbsolute(stored) || /^[A-Za-z]:[\\/]/.test(stored);
  if (!absoluteLike) {
    return path.join(dataRoot, ...stored.split(/[\\/]+/).filter(Boolean));
  }
  if (fs.existsSync(stored)) return stored;
  const normalized = stored.replace(/\\/g, '/');
  const marker = '/outbox/';
  const index = normalized.toLowerCase().lastIndexOf(marker);
  if (index >= 0) {
    const tail = normalized.slice(index + 1);
    return path.join(dataRoot, ...tail.split('/').filter(Boolean));
  }
  return stored;
}

function hydrateAttachments(value) {
  return normalizeAttachments(value).map(item => ({
    ...item,
    path: resolveAttachmentPath(item.path),
  }));
}

function normalizeState(input = {}) {
  const state = input && typeof input === 'object' ? input : {};
  const normalized = {
    accountId: String(state.accountId || ''),
    to: String(state.to || ''),
    cc: String(state.cc || ''),
    bcc: String(state.bcc || ''),
    subject: String(state.subject || ''),
    body: String(state.body || ''),
    mode: ['new', 'reply', 'reply-all', 'forward'].includes(state.mode) ? state.mode : 'new',
    quoteText: String(state.quoteText || ''),
    replyHeaders: state.replyHeaders && typeof state.replyHeaders === 'object'
      ? {
          inReplyTo: state.replyHeaders.inReplyTo ? String(state.replyHeaders.inReplyTo) : undefined,
          references: state.replyHeaders.references || undefined,
        }
      : null,
    useSignature: state.useSignature !== false,
    readReceipt: Boolean(state.readReceipt),
    deliveryReceipt: Boolean(state.deliveryReceipt),
    attachments: normalizeAttachments(state.attachments),
  };
  const encoded = JSON.stringify(normalized);
  if (encoded.length > 8_000_000) throw new Error('Le brouillon est trop volumineux');
  return normalized;
}

function normalizeMail(input = {}) {
  const mail = input && typeof input === 'object' ? input : {};
  const normalized = {
    to: String(mail.to || ''),
    cc: mail.cc ? String(mail.cc) : undefined,
    bcc: mail.bcc ? String(mail.bcc) : undefined,
    subject: String(mail.subject || ''),
    text: String(mail.text || ''),
    html: mail.html ? String(mail.html) : undefined,
    readReceipt: Boolean(mail.readReceipt),
    deliveryReceipt: Boolean(mail.deliveryReceipt),
    inReplyTo: mail.inReplyTo ? String(mail.inReplyTo) : undefined,
    references: mail.references || undefined,
    attachments: normalizeAttachments(mail.attachments),
  };
  const encoded = JSON.stringify(normalized);
  if (encoded.length > 12_000_000) throw new Error('Le message différé est trop volumineux');
  return normalized;
}

function itemDirectory(id) {
  return path.join(attachmentRoot, String(Number(id)));
}

function removeItemFiles(id) {
  if (!id || !attachmentRoot) return;
  fs.rmSync(itemDirectory(id), { recursive: true, force: true });
}

function copyManagedAttachments(id, state, mail = null) {
  const sources = normalizeAttachments(state.attachments);
  const oldDir = itemDirectory(id);
  if (!sources.length) {
    removeItemFiles(id);
    state.attachments = [];
    if (mail) mail.attachments = [];
    return;
  }

  const temporary = `${oldDir}.tmp-${crypto.randomUUID()}`;
  fs.mkdirSync(temporary, { recursive: true });
  const copied = [];
  try {
    sources.forEach((attachment, index) => {
      const source = path.resolve(attachment.path);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
        throw new Error(`Pièce jointe introuvable : ${attachment.filename}`);
      }
      let filename = sanitizeFilename(attachment.filename, index);
      let target = path.join(temporary, filename);
      let suffix = 2;
      while (fs.existsSync(target)) {
        const extension = path.extname(filename);
        const stem = path.basename(filename, extension);
        filename = `${stem}-${suffix++}${extension}`;
        target = path.join(temporary, filename);
      }
      fs.copyFileSync(source, target);
      copied.push({ ...attachment, filename, path: target });
    });
    fs.rmSync(oldDir, { recursive: true, force: true });
    fs.renameSync(temporary, oldDir);
    const finalRows = copied.map(item => ({
      ...item,
      path: persistedAttachmentPath(path.join(oldDir, path.basename(item.path))),
    }));
    state.attachments = finalRows;
    if (mail) mail.attachments = finalRows.map(item => ({ ...item }));
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function rowToPublic(row, { includePayload = true } = {}) {
  if (!row) return null;
  const output = {
    id: Number(row.id),
    kind: row.kind,
    accountId: row.account_id || '',
    subject: row.subject || '',
    recipients: row.recipients || '',
    sendAt: Number(row.send_at) || null,
    status: row.status || 'pending',
    error: row.error || '',
    attempts: Number(row.attempts) || 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
  if (includePayload) {
    output.state = parseJson(row.state_json, {});
    output.mail = parseJson(row.mail_json, null);
    if (output.state && typeof output.state === 'object') {
      output.state.attachments = hydrateAttachments(output.state.attachments);
    }
    if (output.mail && typeof output.mail === 'object') {
      output.mail.attachments = hydrateAttachments(output.mail.attachments);
    }
  }
  return output;
}

function init(db, dataDir) {
  database = db;
  dataRoot = path.resolve(String(dataDir || ''));
  attachmentRoot = path.join(dataRoot, 'outbox');
  fs.mkdirSync(attachmentRoot, { recursive: true });
  database.exec(`
    CREATE TABLE IF NOT EXISTS outbox_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('draft', 'scheduled')),
      account_id TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      recipients TEXT NOT NULL DEFAULT '',
      state_json TEXT NOT NULL DEFAULT '{}',
      mail_json TEXT,
      send_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_kind_updated
      ON outbox_items(kind, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_outbox_due
      ON outbox_items(kind, status, send_at);
  `);
  database.prepare(`
    UPDATE outbox_items
       SET status='pending', error='', updated_at=?
     WHERE kind='scheduled' AND status='sending'
  `).run(now());
}

function list(kind) {
  ensureReady();
  if (!['draft', 'scheduled'].includes(kind)) throw new Error('Type de boîte invalide');
  const orderBy = kind === 'scheduled'
    ? 'COALESCE(send_at, updated_at) ASC, id ASC'
    : 'updated_at DESC, id DESC';
  return database.prepare(`
    SELECT * FROM outbox_items WHERE kind=?
    ORDER BY ${orderBy}
  `).all(kind).map(row => rowToPublic(row, { includePayload: false }));
}

function get(id, kind = null) {
  ensureReady();
  const row = kind
    ? database.prepare('SELECT * FROM outbox_items WHERE id=? AND kind=?').get(Number(id), kind)
    : database.prepare('SELECT * FROM outbox_items WHERE id=?').get(Number(id));
  return rowToPublic(row);
}

function counts() {
  ensureReady();
  const rows = database.prepare(`
    SELECT kind, COUNT(*) AS n
      FROM outbox_items
     WHERE kind='draft' OR (kind='scheduled' AND status IN ('pending','failed','sending'))
     GROUP BY kind
  `).all();
  const result = { drafts: 0, scheduled: 0 };
  for (const row of rows) {
    if (row.kind === 'draft') result.drafts = Number(row.n) || 0;
    if (row.kind === 'scheduled') result.scheduled = Number(row.n) || 0;
  }
  return result;
}

function saveDraft({ id = null, state = {}, removeScheduledId = null } = {}) {
  ensureReady();
  const normalizedState = normalizeState(state);
  const timestamp = now();
  let itemId = Number(id) || null;
  const existing = itemId ? get(itemId, 'draft') : null;
  if (itemId && !existing) throw new Error('Brouillon introuvable');
  const created = !existing;

  if (created) {
    const result = database.prepare(`
      INSERT INTO outbox_items
        (kind, account_id, subject, recipients, state_json, mail_json, send_at,
         status, error, attempts, created_at, updated_at)
      VALUES ('draft', ?, ?, ?, '{}', NULL, NULL, 'pending', '', 0, ?, ?)
    `).run(
      normalizedState.accountId,
      normalizedState.subject,
      normalizedState.to,
      timestamp,
      timestamp,
    );
    itemId = Number(result.lastInsertRowid);
  }

  try {
    copyManagedAttachments(itemId, normalizedState);
    database.prepare(`
      UPDATE outbox_items
         SET account_id=?, subject=?, recipients=?, state_json=?, mail_json=NULL,
             send_at=NULL, status='pending', error='', updated_at=?
       WHERE id=? AND kind='draft'
    `).run(
      normalizedState.accountId,
      normalizedState.subject,
      normalizedState.to,
      JSON.stringify(normalizedState),
      timestamp,
      itemId,
    );
  } catch (error) {
    if (created) {
      database.prepare("DELETE FROM outbox_items WHERE id=? AND kind='draft'").run(itemId);
      removeItemFiles(itemId);
    }
    throw error;
  }

  if (removeScheduledId) remove(removeScheduledId, 'scheduled');
  return get(itemId, 'draft');
}

function saveScheduled({ id = null, accountId = '', state = {}, mail = {}, sendAt, removeDraftId = null } = {}) {
  ensureReady();
  const when = Number(sendAt);
  if (!Number.isFinite(when) || when <= now()) {
    throw new Error('La date d’envoi doit être située dans le futur');
  }
  const normalizedState = normalizeState({ ...state, accountId: accountId || state.accountId });
  const normalizedMail = normalizeMail(mail);
  if (!normalizedMail.to.trim()) throw new Error('Destinataire obligatoire');
  const timestamp = now();
  let itemId = Number(id) || null;
  const existing = itemId ? get(itemId, 'scheduled') : null;
  if (itemId && !existing) throw new Error('Envoi différé introuvable');
  if (existing?.status === 'sending') throw new Error('Cet envoi est déjà en cours');
  const created = !existing;

  if (created) {
    const result = database.prepare(`
      INSERT INTO outbox_items
        (kind, account_id, subject, recipients, state_json, mail_json, send_at,
         status, error, attempts, created_at, updated_at)
      VALUES ('scheduled', ?, ?, ?, '{}', '{}', ?, 'pending', '', 0, ?, ?)
    `).run(
      normalizedState.accountId,
      normalizedState.subject,
      normalizedState.to,
      when,
      timestamp,
      timestamp,
    );
    itemId = Number(result.lastInsertRowid);
  }

  try {
    copyManagedAttachments(itemId, normalizedState, normalizedMail);
    database.prepare(`
      UPDATE outbox_items
         SET account_id=?, subject=?, recipients=?, state_json=?, mail_json=?,
             send_at=?, status='pending', error='', updated_at=?
       WHERE id=? AND kind='scheduled'
    `).run(
      normalizedState.accountId,
      normalizedState.subject,
      normalizedState.to,
      JSON.stringify(normalizedState),
      JSON.stringify(normalizedMail),
      when,
      timestamp,
      itemId,
    );
  } catch (error) {
    if (created) {
      database.prepare("DELETE FROM outbox_items WHERE id=? AND kind='scheduled'").run(itemId);
      removeItemFiles(itemId);
    }
    throw error;
  }

  if (removeDraftId) remove(removeDraftId, 'draft');
  return get(itemId, 'scheduled');
}

function remove(id, kind = null) {
  ensureReady();
  const item = get(id, kind);
  if (!item) return false;
  const result = kind
    ? database.prepare('DELETE FROM outbox_items WHERE id=? AND kind=?').run(Number(id), kind)
    : database.prepare('DELETE FROM outbox_items WHERE id=?').run(Number(id));
  if (result.changes) removeItemFiles(id);
  return Boolean(result.changes);
}

function claimDue(timestamp = now()) {
  ensureReady();
  const transaction = database.transaction(() => {
    const row = database.prepare(`
      SELECT * FROM outbox_items
       WHERE kind='scheduled' AND status='pending' AND send_at<=?
       ORDER BY send_at ASC, id ASC LIMIT 1
    `).get(Number(timestamp));
    if (!row) return null;
    const updated = database.prepare(`
      UPDATE outbox_items
         SET status='sending', error='', attempts=attempts+1, updated_at=?
       WHERE id=? AND status='pending'
    `).run(now(), row.id);
    if (!updated.changes) return null;
    return database.prepare('SELECT * FROM outbox_items WHERE id=?').get(row.id);
  });
  return rowToPublic(transaction());
}

function claim(id) {
  ensureReady();
  const transaction = database.transaction(() => {
    const row = database.prepare(`
      SELECT * FROM outbox_items
       WHERE id=? AND kind='scheduled'
    `).get(Number(id));
    if (!row) return null;
    if (row.status === 'sending') throw new Error('Cet envoi est déjà en cours');
    const updated = database.prepare(`
      UPDATE outbox_items
         SET status='sending', error='', attempts=attempts+1, updated_at=?
       WHERE id=? AND kind='scheduled' AND status IN ('pending','failed')
    `).run(now(), Number(id));
    if (!updated.changes) return null;
    return database.prepare('SELECT * FROM outbox_items WHERE id=?').get(Number(id));
  });
  return rowToPublic(transaction());
}

function markFailed(id, error) {
  ensureReady();
  database.prepare(`
    UPDATE outbox_items SET status='failed', error=?, updated_at=?
     WHERE id=? AND kind='scheduled'
  `).run(String(error || 'Erreur d’envoi'), now(), Number(id));
  return get(id, 'scheduled');
}

function retry(id, sendAt = now() + 60_000) {
  ensureReady();
  database.prepare(`
    UPDATE outbox_items SET status='pending', error='', send_at=?, updated_at=?
     WHERE id=? AND kind='scheduled'
  `).run(Number(sendAt), now(), Number(id));
  return get(id, 'scheduled');
}

module.exports = {
  init,
  list,
  get,
  counts,
  saveDraft,
  saveScheduled,
  remove,
  claimDue,
  claim,
  markFailed,
  retry,
};
