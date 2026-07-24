/**
 * LibraMail — Index SQLite (better-sqlite3, WAL, FTS5)
 * La liste, les dossiers virtuels et les statistiques travaillent uniquement
 * sur l'index local. Les fichiers .eml ne sont lus qu'à l'ouverture d'un mail.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db;

function normalizeSubject(subject) {
  return String(subject || '(sans objet)')
    .replace(/^\s*((re|fw|fwd|tr|aw|sv)\s*:\s*)+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('fr');
}

function fallbackThreadKey(subject, id = '', fromAddr = '', toAddr = '', accountId = '') {
  const normalized = normalizeSubject(subject);
  const participants = [fromAddr, ...String(toAddr || '').split(',')]
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const participantKey = [...new Set(participants)].sort().join('|') || accountId;
  return normalized ? `subject:${normalized}|${participantKey}` : `message:${id}`;
}

function ensureColumn(table, name, sqlType) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(column => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${sqlType}`);
  }
}

function migrateMessageData() {
  ensureColumn('messages', 'thread_key', "TEXT DEFAULT ''");
  ensureColumn('messages', 'in_reply_to', 'TEXT');
  ensureColumn('messages', 'references_json', "TEXT DEFAULT '[]'");
  ensureColumn('messages', 'folder_role', "TEXT DEFAULT 'inbox'");

  db.exec(`
    UPDATE messages
       SET folder_role = CASE
         WHEN upper(folder) = 'INBOX' THEN 'inbox'
         WHEN folder_role IS NULL OR folder_role = '' OR folder_role = 'inbox' THEN 'other'
         ELSE folder_role
       END;
    CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(thread_key, date DESC);
    CREATE INDEX IF NOT EXISTS idx_msg_role ON messages(folder_role, is_spam, date DESC);
  `);

  const missing = db.prepare(`
    SELECT id, subject, from_addr, to_addr, account_id
      FROM messages
     WHERE thread_key IS NULL OR thread_key = ''
  `).all();
  if (!missing.length) return;

  const update = db.prepare('UPDATE messages SET thread_key=? WHERE id=?');
  db.transaction(rows => {
    for (const row of rows) {
      update.run(
        fallbackThreadKey(row.subject, row.id, row.from_addr, row.to_addr, row.account_id),
        row.id
      );
    }
  })(missing);
}

function expectedEmlPath(dataDir, row) {
  const folder = String(row.folder || 'INBOX').replace(/[^\w.-]/g, '_');
  return path.join(dataDir, 'mail', String(row.account_id || ''), folder, `${row.uid}.eml`);
}

/**
 * Retourne d'abord le chemin du message dans le dossier data courant.
 * Un ancien chemin absolu n'est utilisé qu'en dernier recours, notamment
 * pendant la migration d'une version historique.
 */
function resolveEmlPath(dataDir, row) {
  const expected = path.normalize(expectedEmlPath(dataDir, row));
  if (fs.existsSync(expected)) return expected;

  const stored = String(row?.eml_path || '');
  if (!stored) return expected;
  const storedPath = path.isAbsolute(stored)
    ? path.normalize(stored)
    : path.resolve(dataDir, stored);
  return fs.existsSync(storedPath) ? storedPath : expected;
}

/**
 * Répare les chemins enregistrés par les anciennes versions.
 *
 * Point important : le chemin local du paquet courant est toujours prioritaire,
 * même si l'ancien dossier source existe encore. L'ancienne migration gardait
 * alors le chemin d'origine, ce qui donnait une application « portable » aussi
 * longtemps qu'on ne la déplaçait pas, performance conceptuelle remarquable.
 *
 * Si le fichier local n'a pas été copié mais que l'ancien fichier existe encore,
 * il est rapatrié dans data/mail afin de rendre l'instance autonome.
 */
function migrateEmlPaths(dataDir) {
  const rows = db.prepare(`
    SELECT id, account_id, folder, uid, eml_path
      FROM messages
     WHERE eml_path IS NOT NULL AND eml_path <> ''
  `).all();
  if (!rows.length) return { repaired: 0, copied: 0, missing: 0 };

  const update = db.prepare('UPDATE messages SET eml_path=? WHERE id=?');
  let repaired = 0;
  let copied = 0;
  let missing = 0;

  db.transaction(items => {
    for (const row of items) {
      const expected = path.normalize(expectedEmlPath(dataDir, row));
      const stored = String(row.eml_path || '');
      const storedPath = path.isAbsolute(stored)
        ? path.normalize(stored)
        : path.resolve(dataDir, stored);

      if (fs.existsSync(expected)) {
        if (stored !== expected) {
          update.run(expected, row.id);
          repaired++;
        }
        continue;
      }

      if (storedPath !== expected && fs.existsSync(storedPath)) {
        try {
          fs.mkdirSync(path.dirname(expected), { recursive: true });
          fs.copyFileSync(storedPath, expected);
          update.run(expected, row.id);
          copied++;
          continue;
        } catch (error) {
          console.warn(`[LibraMail] Copie impossible pour le message ${row.id}: ${error.message}`);
        }
      }

      missing++;
    }
  })(rows);

  if (repaired || copied || missing) {
    console.log(`[LibraMail] Chemins des messages : ${repaired} rebasés; ${copied} copiés; ${missing} introuvables`);
  }
  return { repaired, copied, missing };
}


function close() {
  if (!db) return;
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  try { db.close(); } finally { db = null; }
}

function init(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(path.join(dataDir, 'index.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');
  db.pragma('foreign_keys = ON');

  db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    account_id TEXT NOT NULL,
    folder TEXT NOT NULL,
    folder_role TEXT DEFAULT 'inbox',
    uid INTEGER NOT NULL,
    message_id TEXT,
    subject TEXT,
    from_name TEXT, from_addr TEXT,
    to_addr TEXT,
    date INTEGER,
    snippet TEXT,
    seen INTEGER DEFAULT 0,
    flagged INTEGER DEFAULT 0,
    answered INTEGER DEFAULT 0,
    has_attach INTEGER DEFAULT 0,
    is_spam INTEGER DEFAULT 0,
    size INTEGER DEFAULT 0,
    eml_path TEXT,
    thread_key TEXT DEFAULT '',
    in_reply_to TEXT,
    references_json TEXT DEFAULT '[]',
    UNIQUE(account_id, folder, uid)
  );
  CREATE INDEX IF NOT EXISTS idx_msg_list ON messages(account_id, folder, date DESC);
  CREATE INDEX IF NOT EXISTS idx_msg_unified ON messages(folder, is_spam, date DESC);
  CREATE INDEX IF NOT EXISTS idx_msg_from_addr ON messages(from_addr COLLATE NOCASE);

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    subject, from_addr, to_addr, body,
    content=''
  );

  CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#8b7dd8'
  );
  CREATE TABLE IF NOT EXISTS message_labels (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, label_id)
  );

  CREATE TABLE IF NOT EXISTS spam_tokens (
    token TEXT PRIMARY KEY,
    ham INTEGER DEFAULT 0,
    spam INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS spam_stats (
    k TEXT PRIMARY KEY, v INTEGER
  );
  INSERT OR IGNORE INTO spam_stats VALUES ('ham_msgs', 0), ('spam_msgs', 0);

  CREATE TABLE IF NOT EXISTS sync_state (
    account_id TEXT, folder TEXT,
    uidvalidity INTEGER, last_uid INTEGER DEFAULT 0,
    PRIMARY KEY (account_id, folder)
  );

  -- Carnet d'adresses local. Les adresses sont normalisées et uniques afin
  -- qu'un expéditeur ne puisse pas se retrouver dans plusieurs fiches.
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    job_title TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    mobile TEXT NOT NULL DEFAULT '',
    postal_address TEXT NOT NULL DEFAULT '',
    birthday TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    avatar_data TEXT NOT NULL DEFAULT '',
    trusted INTEGER NOT NULL DEFAULT 1,
    favorite INTEGER NOT NULL DEFAULT 0,
    preferred_account_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS contact_emails (
    id INTEGER PRIMARY KEY,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    is_primary INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_contact_emails_contact ON contact_emails(contact_id, is_primary DESC);
  CREATE TABLE IF NOT EXISTS contact_groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    color TEXT NOT NULL DEFAULT '#4f8bd6'
  );
  CREATE TABLE IF NOT EXISTS contact_group_members (
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (contact_id, group_id)
  );
  CREATE INDEX IF NOT EXISTS idx_contact_groups_member ON contact_group_members(group_id, contact_id);
  `);

  ensureColumn('contacts', 'avatar_data', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('sync_state', 'highest_modseq', 'TEXT');
  ensureColumn('sync_state', 'message_count', 'INTEGER DEFAULT 0');
  ensureColumn('sync_state', 'last_reconcile', 'INTEGER DEFAULT 0');

  migrateMessageData();
  migrateEmlPaths(dataDir);

  // Les anciennes versions n'activaient pas toujours les clés étrangères.
  // Une suppression de message pouvait donc laisser une association
  // d'étiquette orpheline, comptée dans la barre latérale mais impossible à
  // afficher. Le nettoyage est sans effet sur les associations valides.
  db.exec(`
    DELETE FROM message_labels
     WHERE message_id NOT IN (SELECT id FROM messages)
        OR label_id NOT IN (SELECT id FROM labels);
  `);
  return db;
}

// ---------- Messages ----------
const upsertMessage = message => db.prepare(`
  INSERT INTO messages (account_id, folder, folder_role, uid, message_id, subject,
    from_name, from_addr, to_addr, date, snippet, seen, flagged, answered,
    has_attach, size, eml_path, is_spam, thread_key, in_reply_to, references_json)
  VALUES (@account_id,@folder,@folder_role,@uid,@message_id,@subject,@from_name,
    @from_addr,@to_addr,@date,@snippet,@seen,@flagged,@answered,@has_attach,@size,
    @eml_path,@is_spam,@thread_key,@in_reply_to,@references_json)
  ON CONFLICT(account_id, folder, uid) DO UPDATE SET
    folder_role=excluded.folder_role,
    message_id=COALESCE(excluded.message_id, messages.message_id),
    subject=excluded.subject,
    from_name=excluded.from_name,
    from_addr=excluded.from_addr,
    to_addr=excluded.to_addr,
    date=excluded.date,
    snippet=excluded.snippet,
    seen=excluded.seen,
    flagged=excluded.flagged,
    answered=excluded.answered,
    has_attach=excluded.has_attach,
    size=excluded.size,
    eml_path=excluded.eml_path,
    is_spam=CASE WHEN excluded.folder_role='junk' THEN 1 ELSE messages.is_spam END,
    thread_key=CASE WHEN excluded.thread_key <> '' THEN excluded.thread_key ELSE messages.thread_key END,
    in_reply_to=COALESCE(excluded.in_reply_to, messages.in_reply_to),
    references_json=CASE WHEN excluded.references_json <> '[]' THEN excluded.references_json ELSE messages.references_json END
  RETURNING id
`).get(message);

function deleteFtsRow(rowId) {
  const exists = db.prepare('SELECT rowid FROM messages_fts WHERE rowid=?').get(rowId);
  if (exists) {
    db.prepare("INSERT INTO messages_fts(messages_fts, rowid) VALUES('delete', ?)").run(rowId);
  }
}

function indexBody(rowId, message, body) {
  deleteFtsRow(rowId);
  db.prepare(`INSERT INTO messages_fts(rowid, subject, from_addr, to_addr, body)
              VALUES (?,?,?,?,?)`)
    .run(
      rowId,
      message.subject || '',
      message.from_addr || '',
      message.to_addr || '',
      (body || '').slice(0, 200000)
    );
}

function normalizeSort(sortBy = 'date', sortDirection = 'desc') {
  const allowed = new Set(['date', 'sender', 'subject', 'unread']);
  return {
    sortBy: allowed.has(sortBy) ? sortBy : 'date',
    direction: String(sortDirection).toLowerCase() === 'asc' ? 'ASC' : 'DESC',
  };
}

function messageOrder(sortBy, sortDirection, alias = 'm') {
  const sort = normalizeSort(sortBy, sortDirection);
  if (sort.sortBy === 'sender') {
    return `lower(COALESCE(NULLIF(${alias}.from_name, ''), ${alias}.from_addr, '')) ${sort.direction}, ${alias}.date DESC, ${alias}.id DESC`;
  }
  if (sort.sortBy === 'subject') {
    return `lower(COALESCE(${alias}.subject, '')) ${sort.direction}, ${alias}.date DESC, ${alias}.id DESC`;
  }
  if (sort.sortBy === 'unread') {
    const unreadOrder = sort.direction === 'DESC' ? 'ASC' : 'DESC';
    return `${alias}.seen ${unreadOrder}, ${alias}.date DESC, ${alias}.id DESC`;
  }
  return `${alias}.date ${sort.direction}, ${alias}.id ${sort.direction}`;
}

function conversationOrder(sortBy, sortDirection, alias = 'r') {
  const sort = normalizeSort(sortBy, sortDirection);
  if (sort.sortBy === 'sender') {
    return `lower(COALESCE(NULLIF(${alias}.from_name, ''), ${alias}.from_addr, '')) ${sort.direction}, ${alias}.date DESC, ${alias}.id DESC`;
  }
  if (sort.sortBy === 'subject') {
    return `lower(COALESCE(${alias}.subject, '')) ${sort.direction}, ${alias}.date DESC, ${alias}.id DESC`;
  }
  if (sort.sortBy === 'unread') {
    const unreadOrder = sort.direction === 'DESC' ? 'DESC' : 'ASC';
    return `${alias}.thread_unread ${unreadOrder}, ${alias}.date DESC, ${alias}.id DESC`;
  }
  return `${alias}.date ${sort.direction}, ${alias}.id ${sort.direction}`;
}

function buildFilter({
  accountId = null,
  folder = null,
  folderRole = null,
  folderRoles = null,
  spam = 0,
  labelId = null,
} = {}) {
  const join = labelId
    ? 'JOIN message_labels mlf ON mlf.message_id = m.id AND mlf.label_id = @labelId'
    : '';
  const where = [];
  const params = {};

  if (folder) {
    where.push('m.folder = @folder');
    params.folder = folder;
  }
  if (folderRole) {
    where.push('m.folder_role = @folderRole');
    params.folderRole = folderRole;
  }
  if (Array.isArray(folderRoles) && folderRoles.length) {
    const placeholders = folderRoles.map((_, index) => `@folderRole${index}`).join(',');
    where.push(`m.folder_role IN (${placeholders})`);
    folderRoles.forEach((role, index) => { params[`folderRole${index}`] = role; });
  }
  if (spam !== null && spam !== undefined) {
    where.push('m.is_spam = @spam');
    params.spam = Number(spam) ? 1 : 0;
  }
  if (accountId) {
    where.push('m.account_id = @accountId');
    params.accountId = accountId;
  }
  if (labelId) params.labelId = labelId;

  return { join, where: where.length ? where.join(' AND ') : '1=1', params };
}

function listMessages({ limit = 200, offset = 0, sortBy = 'date', sortDirection = 'desc', ...filters } = {}) {
  const filter = buildFilter(filters);
  const order = messageOrder(sortBy, sortDirection);
  return db.prepare(`SELECT m.id, m.account_id, m.folder, m.folder_role, m.uid, m.thread_key,
      m.subject, m.from_name, m.from_addr, m.to_addr, m.date, m.snippet,
      m.seen, m.flagged, m.answered, m.has_attach, m.is_spam,
      (SELECT c.display_name FROM contact_emails ce JOIN contacts c ON c.id=ce.contact_id
         WHERE ce.email=m.from_addr COLLATE NOCASE LIMIT 1) AS contact_name,
      EXISTS(SELECT 1 FROM contact_emails ce JOIN contacts c ON c.id=ce.contact_id
         WHERE ce.email=m.from_addr COLLATE NOCASE AND c.trusted=1) AS contact_trusted,
      (SELECT json_group_array(json_object('name', l.name, 'color', l.color))
         FROM message_labels ml JOIN labels l ON l.id = ml.label_id
        WHERE ml.message_id = m.id) AS labels
    FROM messages m ${filter.join}
    WHERE ${filter.where}
    ORDER BY ${order} LIMIT @limit OFFSET @offset`)
    .all({ ...filter.params, limit, offset });
}

function countMessages(filters = {}) {
  const filter = buildFilter(filters);
  return db.prepare(`SELECT COUNT(*) AS n,
      COALESCE(SUM(CASE WHEN m.seen=0 THEN 1 ELSE 0 END), 0) AS unread
    FROM messages m ${filter.join}
    WHERE ${filter.where}`).get(filter.params);
}

function listConversations({ limit = 200, offset = 0, sortBy = 'date', sortDirection = 'desc', ...filters } = {}) {
  const filter = buildFilter(filters);
  const order = conversationOrder(sortBy, sortDirection);
  return db.prepare(`
    WITH filtered AS (
      SELECT m.*,
             COALESCE(NULLIF(m.thread_key, ''), 'message:' || m.id) AS conversation_key
        FROM messages m ${filter.join}
       WHERE ${filter.where}
    ), ranked AS (
      SELECT filtered.*,
             COUNT(*) OVER (PARTITION BY conversation_key) AS thread_count,
             SUM(CASE WHEN seen=0 THEN 1 ELSE 0 END)
               OVER (PARTITION BY conversation_key) AS thread_unread,
             MAX(flagged) OVER (PARTITION BY conversation_key) AS thread_flagged,
             MAX(has_attach) OVER (PARTITION BY conversation_key) AS thread_has_attach,
             ROW_NUMBER() OVER (PARTITION BY conversation_key ORDER BY date DESC, id DESC) AS rn
        FROM filtered
    )
    SELECT r.id, r.account_id, r.folder, r.folder_role, r.uid,
           r.conversation_key AS thread_key,
           r.subject, r.from_name, r.from_addr, r.to_addr, r.date, r.snippet,
           CASE WHEN r.thread_unread > 0 THEN 0 ELSE 1 END AS seen,
           r.thread_flagged AS flagged,
           r.answered, r.thread_has_attach AS has_attach, r.is_spam,
           (SELECT c.display_name FROM contact_emails ce JOIN contacts c ON c.id=ce.contact_id
             WHERE ce.email=r.from_addr COLLATE NOCASE LIMIT 1) AS contact_name,
           EXISTS(SELECT 1 FROM contact_emails ce JOIN contacts c ON c.id=ce.contact_id
             WHERE ce.email=r.from_addr COLLATE NOCASE AND c.trusted=1) AS contact_trusted,
           r.thread_count, r.thread_unread, 1 AS is_thread,
           (SELECT group_concat(DISTINCT COALESCE(
              (SELECT c.display_name FROM contact_emails ce JOIN contacts c ON c.id=ce.contact_id
                WHERE ce.email=m2.from_addr COLLATE NOCASE LIMIT 1),
              NULLIF(m2.from_name, ''), m2.from_addr))
              FROM messages m2
             WHERE COALESCE(NULLIF(m2.thread_key, ''), 'message:' || m2.id) = r.conversation_key
           ) AS participants,
           (SELECT json_group_array(json_object('name', l.name, 'color', l.color))
              FROM message_labels ml JOIN labels l ON l.id = ml.label_id
             WHERE ml.message_id IN (
               SELECT m3.id FROM messages m3
                WHERE COALESCE(NULLIF(m3.thread_key, ''), 'message:' || m3.id) = r.conversation_key
             )) AS labels
      FROM ranked r
     WHERE r.rn = 1
     ORDER BY ${order}
     LIMIT @limit OFFSET @offset
  `).all({ ...filter.params, limit, offset });
}

function countConversations(filters = {}) {
  const filter = buildFilter(filters);
  return db.prepare(`
    SELECT COUNT(DISTINCT COALESCE(NULLIF(m.thread_key, ''), 'message:' || m.id)) AS n,
           COUNT(*) AS messages,
           COALESCE(SUM(CASE WHEN m.seen=0 THEN 1 ELSE 0 END), 0) AS unread
      FROM messages m ${filter.join}
     WHERE ${filter.where}
  `).get(filter.params);
}

function getConversation(threadKey) {
  return db.prepare(`
    SELECT m.id, m.account_id, m.folder, m.folder_role, m.uid, m.thread_key,
           m.subject, m.from_name, m.from_addr, m.to_addr, m.date, m.snippet,
           m.seen, m.flagged, m.answered, m.has_attach, m.is_spam,
           (SELECT c.display_name FROM contact_emails ce JOIN contacts c ON c.id=ce.contact_id
             WHERE ce.email=m.from_addr COLLATE NOCASE LIMIT 1) AS contact_name,
           EXISTS(SELECT 1 FROM contact_emails ce JOIN contacts c ON c.id=ce.contact_id
             WHERE ce.email=m.from_addr COLLATE NOCASE AND c.trusted=1) AS contact_trusted
      FROM messages m
     WHERE COALESCE(NULLIF(m.thread_key, ''), 'message:' || m.id) = ?
     ORDER BY m.date ASC, m.id ASC
  `).all(threadKey);
}

function findThreadKeyByMessageIds(messageIds) {
  const ids = [...new Set((messageIds || [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean))];
  if (!ids.length) return null;
  const placeholders = ids.map(() => '?').join(',');
  const row = db.prepare(`
    SELECT thread_key FROM messages
     WHERE lower(message_id) IN (${placeholders})
       AND thread_key IS NOT NULL AND thread_key <> ''
     ORDER BY date ASC LIMIT 1
  `).get(...ids);
  return row?.thread_key || null;
}

function search(query, { limit = 200, sortBy = 'date', sortDirection = 'desc' } = {}) {
  const order = messageOrder(sortBy, sortDirection);
  return db.prepare(`
    SELECT m.id, m.account_id, m.folder, m.folder_role, m.uid, m.thread_key,
           m.subject, m.from_name, m.from_addr, m.to_addr, m.date, m.snippet,
           m.seen, m.flagged, m.answered, m.has_attach, m.is_spam,
           (SELECT c.display_name FROM contact_emails ce JOIN contacts c ON c.id=ce.contact_id
             WHERE ce.email=m.from_addr COLLATE NOCASE LIMIT 1) AS contact_name,
           EXISTS(SELECT 1 FROM contact_emails ce JOIN contacts c ON c.id=ce.contact_id
             WHERE ce.email=m.from_addr COLLATE NOCASE AND c.trusted=1) AS contact_trusted
      FROM messages_fts f JOIN messages m ON m.id = f.rowid
     WHERE messages_fts MATCH ? ORDER BY ${order} LIMIT ?
  `).all(query, limit);
}

function setConversationSeen(threadKey, value) {
  const messages = getConversation(threadKey);
  const update = db.prepare('UPDATE messages SET seen=? WHERE id=?');
  db.transaction(rows => {
    for (const message of rows) update.run(value ? 1 : 0, message.id);
  })(messages);
  return messages;
}

const getMessage = id => db.prepare('SELECT * FROM messages WHERE id=?').get(id);

function getMessagesByIds(ids) {
  const uniqueIds = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
  const rows = [];
  for (let index = 0; index < uniqueIds.length; index += 400) {
    const chunk = uniqueIds.slice(index, index + 400);
    const placeholders = chunk.map(() => '?').join(',');
    rows.push(...db.prepare(`SELECT * FROM messages WHERE id IN (${placeholders})`).all(...chunk));
  }
  return rows;
}
const setFlag = (id, column, value) => {
  if (!['seen', 'flagged', 'answered'].includes(column)) throw new Error('Drapeau invalide');
  return db.prepare(`UPDATE messages SET ${column}=? WHERE id=?`).run(value ? 1 : 0, id);
};

function deleteMessage(id) {
  deleteFtsRow(id);
  return db.prepare(`DELETE FROM messages WHERE id=?
                     RETURNING id, eml_path, account_id, folder, folder_role, uid`).get(id);
}

function deleteMessages(ids) {
  const uniqueIds = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
  if (!uniqueIds.length) return [];
  const get = db.prepare('SELECT * FROM messages WHERE id=?');
  const remove = db.prepare('DELETE FROM messages WHERE id=?');
  return db.transaction(messageIds => {
    const removed = [];
    for (const id of messageIds) {
      const message = get.get(id);
      if (!message) continue;
      deleteFtsRow(id);
      remove.run(id);
      removed.push(message);
    }
    return removed;
  })(uniqueIds);
}


function deleteAccountData(accountId) {
  const rows = db.prepare('SELECT * FROM messages WHERE account_id=?').all(accountId);
  const removeMessage = db.prepare('DELETE FROM messages WHERE id=?');
  const removeLabels = db.prepare('DELETE FROM message_labels WHERE message_id=?');
  const tx = db.transaction(messages => {
    for (const message of messages) {
      deleteFtsRow(message.id);
      removeLabels.run(message.id);
      removeMessage.run(message.id);
    }
    db.prepare('DELETE FROM sync_state WHERE account_id=?').run(accountId);
  });
  tx(rows);
  return rows;
}

function listMessagesForRetention(accountId, cutoff) {
  return db.prepare(`
    SELECT * FROM messages
     WHERE account_id=?
       AND is_spam=1
       AND folder_role IN ('inbox', 'junk')
       AND date < ?
     ORDER BY folder, uid
  `).all(accountId, cutoff);
}

function listSpamMessages(accountId = null) {
  const sql = `SELECT * FROM messages
                WHERE is_spam=1 AND folder_role IN ('inbox','junk')
                ${accountId ? 'AND account_id=?' : ''}
                ORDER BY account_id, folder, uid`;
  return accountId ? db.prepare(sql).all(accountId) : db.prepare(sql).all();
}

function listMessagesByRole(folderRole, accountId = null) {
  const sql = `SELECT * FROM messages WHERE folder_role=?
               ${accountId ? 'AND account_id=?' : ''}
               ORDER BY account_id, folder, uid`;
  return accountId
    ? db.prepare(sql).all(folderRole, accountId)
    : db.prepare(sql).all(folderRole);
}

// ---------- Statistiques ----------
function resolveStatisticsPeriod(value) {
  const key = ['7d', '30d', '90d', '365d', 'all'].includes(value) ? value : '30d';
  if (key === 'all') return { key, from: null, to: null, previousFrom: null, previousTo: null, days: null };

  const days = Number.parseInt(key, 10);
  const now = new Date();
  const toDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1);
  const from = fromDate.getTime();
  const to = toDate.getTime();
  return {
    key,
    from,
    to,
    previousFrom: from - (days * 86400000),
    previousTo: from,
    days,
  };
}

function statisticsWhere({ accountId = null, from = null, to = null } = {}, alias = 'm') {
  const clauses = ['@statsOne=@statsOne'];
  const params = { statsOne: 1 };
  if (accountId) {
    clauses.push(`${alias}.account_id=@accountId`);
    params.accountId = accountId;
  }
  if (from != null) {
    clauses.push(`${alias}.date>=@from`);
    params.from = Number(from);
  }
  if (to != null) {
    clauses.push(`${alias}.date<@to`);
    params.to = Number(to);
  }
  return { sql: clauses.join(' AND '), params };
}

function statisticsSummary(filter) {
  const where = statisticsWhere(filter);
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN folder_role NOT IN ('sent','trash') THEN 1 ELSE 0 END), 0) AS received,
           COALESCE(SUM(CASE WHEN folder_role='sent' THEN 1 ELSE 0 END), 0) AS sent,
           COALESCE(SUM(CASE WHEN folder_role='trash' THEN 1 ELSE 0 END), 0) AS trash,
           COALESCE(SUM(CASE WHEN seen=0 AND folder_role NOT IN ('sent','trash') THEN 1 ELSE 0 END), 0) AS unread,
           COALESCE(SUM(CASE WHEN flagged=1 THEN 1 ELSE 0 END), 0) AS flagged,
           COALESCE(SUM(CASE WHEN answered=1 AND folder_role NOT IN ('sent','trash') THEN 1 ELSE 0 END), 0) AS answered,
           COALESCE(SUM(CASE WHEN is_spam=1 OR folder_role='junk' THEN 1 ELSE 0 END), 0) AS spam,
           COALESCE(SUM(CASE WHEN has_attach=1 THEN 1 ELSE 0 END), 0) AS attachments,
           COALESCE(SUM(size), 0) AS totalSize,
           COUNT(DISTINCT COALESCE(NULLIF(thread_key, ''), 'message:' || id)) AS conversations,
           COUNT(DISTINCT date(date / 1000, 'unixepoch', 'localtime')) AS activeDays,
           MIN(date) AS oldestDate,
           MAX(date) AS newestDate
      FROM messages m
     WHERE ${where.sql}
  `).get(where.params);

  const received = Number(row.received) || 0;
  const unread = Number(row.unread) || 0;
  const total = Number(row.total) || 0;
  const activeDays = Math.max(1, Number(row.activeDays) || 0);
  return {
    ...row,
    readRate: received ? ((received - unread) / received) * 100 : 0,
    spamRate: received ? (Number(row.spam || 0) / received) * 100 : 0,
    attachmentRate: total ? (Number(row.attachments || 0) / total) * 100 : 0,
    responseRate: received ? (Number(row.answered || 0) / received) * 100 : 0,
    averagePerActiveDay: total / activeDays,
  };
}

function getStatistics(options = {}) {
  const period = resolveStatisticsPeriod(options.period);
  const accountId = options.accountId || null;
  const filter = { accountId, from: period.from, to: period.to };
  const where = statisticsWhere(filter);
  const summary = statisticsSummary(filter);
  const globalSummary = statisticsSummary({ accountId });

  let previous = null;
  if (period.previousFrom != null) {
    previous = statisticsSummary({
      accountId,
      from: period.previousFrom,
      to: period.previousTo,
    });
  }

  const spanDays = period.days || Math.max(1,
    Math.ceil(((Number(summary.newestDate) || Date.now()) - (Number(summary.oldestDate) || Date.now())) / 86400000) + 1
  );
  const grain = spanDays <= 45 ? 'day' : spanDays <= 180 ? 'week' : 'month';
  const bucketExpression = grain === 'day'
    ? "strftime('%Y-%m-%d', m.date / 1000, 'unixepoch', 'localtime')"
    : grain === 'week'
      ? "strftime('%Y-W%W', m.date / 1000, 'unixepoch', 'localtime')"
      : "strftime('%Y-%m', m.date / 1000, 'unixepoch', 'localtime')";

  const timeline = db.prepare(`
    SELECT ${bucketExpression} AS bucket,
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN m.folder_role NOT IN ('sent','trash') THEN 1 ELSE 0 END), 0) AS received,
           COALESCE(SUM(CASE WHEN m.folder_role='sent' THEN 1 ELSE 0 END), 0) AS sent,
           COALESCE(SUM(CASE WHEN m.seen=0 AND m.folder_role NOT IN ('sent','trash') THEN 1 ELSE 0 END), 0) AS unread
      FROM messages m
     WHERE ${where.sql}
     GROUP BY bucket
     ORDER BY bucket
  `).all(where.params);

  const byAccount = db.prepare(`
    SELECT m.account_id,
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN m.folder_role NOT IN ('sent','trash') THEN 1 ELSE 0 END), 0) AS received,
           COALESCE(SUM(CASE WHEN m.folder_role='sent' THEN 1 ELSE 0 END), 0) AS sent,
           COALESCE(SUM(CASE WHEN m.seen=0 AND m.folder_role NOT IN ('sent','trash') THEN 1 ELSE 0 END), 0) AS unread,
           COALESCE(SUM(CASE WHEN m.is_spam=1 OR m.folder_role='junk' THEN 1 ELSE 0 END), 0) AS spam,
           COALESCE(SUM(CASE WHEN m.has_attach=1 THEN 1 ELSE 0 END), 0) AS attachments,
           COALESCE(SUM(m.size), 0) AS totalSize
      FROM messages m
     WHERE ${where.sql}
     GROUP BY m.account_id
     ORDER BY total DESC
  `).all(where.params);

  const byFolder = db.prepare(`
    SELECT COALESCE(NULLIF(m.folder_role, ''), 'other') AS role,
           COUNT(*) AS total,
           COALESCE(SUM(m.size), 0) AS totalSize
      FROM messages m
     WHERE ${where.sql}
     GROUP BY role
     ORDER BY total DESC
  `).all(where.params);

  const byWeekday = db.prepare(`
    SELECT CAST(strftime('%w', m.date / 1000, 'unixepoch', 'localtime') AS INTEGER) AS weekday,
           COALESCE(SUM(CASE WHEN m.folder_role NOT IN ('sent','trash') THEN 1 ELSE 0 END), 0) AS received,
           COALESCE(SUM(CASE WHEN m.folder_role='sent' THEN 1 ELSE 0 END), 0) AS sent
      FROM messages m
     WHERE ${where.sql}
     GROUP BY weekday
     ORDER BY weekday
  `).all(where.params);

  const byHour = db.prepare(`
    SELECT CAST(strftime('%H', m.date / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
           COUNT(*) AS total
      FROM messages m
     WHERE ${where.sql}
       AND m.folder_role NOT IN ('sent','trash')
     GROUP BY hour
     ORDER BY hour
  `).all(where.params);

  const topSenders = db.prepare(`
    SELECT COALESCE(NULLIF(m.from_name, ''), m.from_addr, '(inconnu)') AS sender,
           m.from_addr AS address,
           COUNT(*) AS total,
           MAX(m.date) AS lastDate,
           COALESCE(SUM(m.size), 0) AS totalSize
      FROM messages m
     WHERE ${where.sql}
       AND m.folder_role NOT IN ('sent','trash')
     GROUP BY lower(COALESCE(m.from_addr, m.from_name, ''))
     ORDER BY total DESC, lastDate DESC
     LIMIT 12
  `).all(where.params);

  const topRecipients = db.prepare(`
    SELECT COALESCE(NULLIF(m.to_addr, ''), '(inconnu)') AS recipient,
           COUNT(*) AS total,
           MAX(m.date) AS lastDate,
           COALESCE(SUM(m.size), 0) AS totalSize
      FROM messages m
     WHERE ${where.sql}
       AND m.folder_role='sent'
     GROUP BY lower(COALESCE(m.to_addr, ''))
     ORDER BY total DESC, lastDate DESC
     LIMIT 12
  `).all(where.params);

  const topDomains = db.prepare(`
    SELECT lower(substr(m.from_addr, instr(m.from_addr, '@') + 1)) AS domain,
           COUNT(*) AS total
      FROM messages m
     WHERE ${where.sql}
       AND m.folder_role NOT IN ('sent','trash')
       AND instr(COALESCE(m.from_addr, ''), '@') > 0
     GROUP BY domain
     HAVING domain <> ''
     ORDER BY total DESC
     LIMIT 12
  `).all(where.params);

  const labels = db.prepare(`
    SELECT l.id, l.name, l.color, COUNT(DISTINCT m.id) AS total
      FROM labels l
      JOIN message_labels ml ON ml.label_id=l.id
      JOIN messages m ON m.id=ml.message_id
     WHERE ${where.sql}
     GROUP BY l.id, l.name, l.color
     ORDER BY total DESC, l.name COLLATE NOCASE
     LIMIT 16
  `).all(where.params);

  const unreadAge = db.prepare(`
    SELECT CASE
             WHEN m.date >= (strftime('%s','now','-1 day') * 1000) THEN 'day'
             WHEN m.date >= (strftime('%s','now','-7 days') * 1000) THEN 'week'
             WHEN m.date >= (strftime('%s','now','-30 days') * 1000) THEN 'month'
             WHEN m.date >= (strftime('%s','now','-90 days') * 1000) THEN 'quarter'
             ELSE 'older'
           END AS age,
           COUNT(*) AS total
      FROM messages m
     WHERE ${where.sql}
       AND m.seen=0
       AND m.folder_role NOT IN ('sent','trash')
     GROUP BY age
  `).all(where.params);

  const largestMessages = db.prepare(`
    SELECT m.id, m.account_id, m.subject, m.from_name, m.from_addr, m.to_addr,
           m.date, m.size, m.folder_role, m.has_attach
      FROM messages m
     WHERE ${where.sql}
     ORDER BY m.size DESC, m.date DESC
     LIMIT 12
  `).all(where.params);

  return {
    period: {
      key: period.key,
      from: period.from,
      to: period.to,
      days: period.days,
      grain,
    },
    accountId,
    summary,
    globalSummary,
    previous,
    timeline,
    byAccount,
    byFolder,
    byWeekday,
    byHour,
    topSenders,
    topRecipients,
    topDomains,
    labels,
    unreadAge,
    largestMessages,
  };
}

// ---------- Étiquettes ----------
function normalizeLabelInput(name, color) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Le nom de l’étiquette est obligatoire');
  if (cleanName.length > 80) throw new Error('Le nom de l’étiquette est trop long');
  const cleanColor = /^#[0-9a-f]{6}$/i.test(String(color || '').trim())
    ? String(color).trim().toLowerCase()
    : '#8b7dd8';
  return { name: cleanName, color: cleanColor };
}

const listLabels = () => db.prepare(`
  SELECT l.id, l.name, l.color, COUNT(DISTINCT m.id) AS message_count
    FROM labels l
    LEFT JOIN message_labels ml ON ml.label_id = l.id
    LEFT JOIN messages m ON m.id = ml.message_id
   GROUP BY l.id, l.name, l.color
   ORDER BY l.name COLLATE NOCASE
`).all();
function addLabel(name, color) {
  const clean = normalizeLabelInput(name, color);
  return db.prepare('INSERT INTO labels(name,color) VALUES(?,?)').run(clean.name, clean.color);
}
function updateLabel(id, name, color) {
  const clean = normalizeLabelInput(name, color);
  return db.prepare('UPDATE labels SET name=?, color=? WHERE id=?').run(clean.name, clean.color, id);
}
function removeLabel(id) {
  return db.transaction(labelId => {
    db.prepare('DELETE FROM message_labels WHERE label_id=?').run(labelId);
    return db.prepare('DELETE FROM labels WHERE id=?').run(labelId);
  })(id);
}
const tagMessage = (messageId, labelId) => db.prepare('INSERT OR IGNORE INTO message_labels VALUES(?,?)').run(messageId, labelId);
const untagMessage = (messageId, labelId) => db.prepare('DELETE FROM message_labels WHERE message_id=? AND label_id=?').run(messageId, labelId);

function tagMessages(messageIds, labelId) {
  const uniqueIds = [...new Set((messageIds || []).map(Number).filter(Number.isInteger))];
  const statement = db.prepare('INSERT OR IGNORE INTO message_labels(message_id,label_id) VALUES(?,?)');
  return db.transaction(ids => {
    let changed = 0;
    for (const messageId of ids) changed += statement.run(messageId, labelId).changes;
    return changed;
  })(uniqueIds);
}

function untagMessages(messageIds, labelId) {
  const uniqueIds = [...new Set((messageIds || []).map(Number).filter(Number.isInteger))];
  return db.transaction(ids => {
    let changed = 0;
    for (let index = 0; index < ids.length; index += 400) {
      const chunk = ids.slice(index, index + 400);
      const placeholders = chunk.map(() => '?').join(',');
      changed += db.prepare(`DELETE FROM message_labels
                              WHERE label_id=? AND message_id IN (${placeholders})`)
        .run(labelId, ...chunk).changes;
    }
    return changed;
  })(uniqueIds);
}

function labelStateForMessages(messageIds) {
  const uniqueIds = [...new Set((messageIds || []).map(Number).filter(Number.isInteger))];
  const labels = listLabels();
  if (!uniqueIds.length) {
    return labels.map(label => ({ ...label, applied_count: 0, selected_count: 0 }));
  }
  const counts = new Map();
  for (let index = 0; index < uniqueIds.length; index += 400) {
    const chunk = uniqueIds.slice(index, index + 400);
    const placeholders = chunk.map(() => '?').join(',');
    const applied = db.prepare(`SELECT label_id, COUNT(DISTINCT message_id) AS applied_count
                                  FROM message_labels
                                 WHERE message_id IN (${placeholders})
                                 GROUP BY label_id`).all(...chunk);
    for (const row of applied) {
      const labelId = Number(row.label_id);
      counts.set(labelId, (counts.get(labelId) || 0) + (Number(row.applied_count) || 0));
    }
  }
  return labels.map(label => ({
    ...label,
    applied_count: counts.get(Number(label.id)) || 0,
    selected_count: uniqueIds.length,
  }));
}


// ---------- Contacts ----------
function normalizeContactEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validContactEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeContactEmail(value));
}

function normalizeAvatarData(value) {
  const avatar = String(value || '').trim();
  if (!avatar) return '';
  if (!/^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=\r\n]+$/i.test(avatar)) return '';
  return avatar.length <= 950000 ? avatar : '';
}

function normalizeContactInput(input = {}) {
  const sourceEmails = Array.isArray(input.emails) ? input.emails : [];
  const seen = new Set();
  const emails = [];
  for (const item of sourceEmails) {
    const email = normalizeContactEmail(typeof item === 'string' ? item : item?.email);
    if (!validContactEmail(email) || seen.has(email)) continue;
    seen.add(email);
    emails.push({
      email,
      label: String(typeof item === 'string' ? '' : item?.label || '').trim().slice(0, 40),
      isPrimary: Boolean(typeof item === 'string' ? emails.length === 0 : item?.isPrimary),
    });
  }
  if (emails.length && !emails.some(item => item.isPrimary)) emails[0].isPrimary = true;
  if (emails.filter(item => item.isPrimary).length > 1) {
    let primarySeen = false;
    for (const item of emails) {
      if (!item.isPrimary) continue;
      if (primarySeen) item.isPrimary = false;
      primarySeen = true;
    }
  }
  const firstName = String(input.firstName || '').trim().slice(0, 120);
  const lastName = String(input.lastName || '').trim().slice(0, 120);
  const displayName = String(input.displayName || '').trim().slice(0, 240)
    || [firstName, lastName].filter(Boolean).join(' ')
    || emails[0]?.email || '';
  if (!displayName && !emails.length) throw new Error('Le contact doit avoir un nom ou une adresse e-mail');
  return {
    displayName,
    firstName,
    lastName,
    company: String(input.company || '').trim().slice(0, 180),
    jobTitle: String(input.jobTitle || '').trim().slice(0, 180),
    phone: String(input.phone || '').trim().slice(0, 80),
    mobile: String(input.mobile || '').trim().slice(0, 80),
    postalAddress: String(input.postalAddress || '').trim().slice(0, 1000),
    birthday: String(input.birthday || '').trim().slice(0, 20),
    notes: String(input.notes || '').trim().slice(0, 8000),
    avatarData: normalizeAvatarData(input.avatarData),
    trusted: input.trusted !== false,
    favorite: Boolean(input.favorite),
    preferredAccountId: String(input.preferredAccountId || '').trim() || null,
    emails,
    groupNames: [...new Set((Array.isArray(input.groups) ? input.groups : [])
      .map(group => String(typeof group === 'string' ? group : group?.name || '').trim())
      .filter(Boolean))].slice(0, 50),
  };
}

function parseContactJson(value, fallback = []) {
  try { return JSON.parse(value || '[]'); } catch { return fallback; }
}

function contactSelectSql(where = '', order = '') {
  return `
    SELECT c.*,
      COALESCE((SELECT ce.email FROM contact_emails ce
                 WHERE ce.contact_id=c.id ORDER BY ce.is_primary DESC, ce.id LIMIT 1), '') AS primary_email,
      COALESCE((SELECT json_group_array(json_object(
                    'id', ce.id, 'email', ce.email, 'label', ce.label,
                    'isPrimary', ce.is_primary))
                  FROM contact_emails ce WHERE ce.contact_id=c.id), '[]') AS emails_json,
      COALESCE((SELECT json_group_array(json_object(
                    'id', g.id, 'name', g.name, 'color', g.color))
                  FROM contact_group_members cgm
                  JOIN contact_groups g ON g.id=cgm.group_id
                 WHERE cgm.contact_id=c.id), '[]') AS groups_json,
      (SELECT COUNT(*) FROM messages m
        WHERE EXISTS (SELECT 1 FROM contact_emails ce2
                       WHERE ce2.contact_id=c.id
                         AND (m.from_addr=ce2.email COLLATE NOCASE OR instr(lower(COALESCE(m.to_addr,'')), ce2.email)>0))) AS message_count,
      (SELECT MAX(m.date) FROM messages m
        WHERE EXISTS (SELECT 1 FROM contact_emails ce3
                       WHERE ce3.contact_id=c.id
                         AND (m.from_addr=ce3.email COLLATE NOCASE OR instr(lower(COALESCE(m.to_addr,'')), ce3.email)>0))) AS last_message_date
    FROM contacts c ${where} ${order}`;
}

function decorateContact(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    displayName: row.display_name || '',
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    company: row.company || '',
    jobTitle: row.job_title || '',
    phone: row.phone || '',
    mobile: row.mobile || '',
    postalAddress: row.postal_address || '',
    birthday: row.birthday || '',
    notes: row.notes || '',
    avatarData: row.avatar_data || '',
    trusted: Boolean(row.trusted),
    favorite: Boolean(row.favorite),
    preferredAccountId: row.preferred_account_id || '',
    primaryEmail: row.primary_email || '',
    emails: parseContactJson(row.emails_json).map(item => ({
      ...item, id: Number(item.id), isPrimary: Boolean(item.isPrimary),
    })),
    groups: parseContactJson(row.groups_json).map(item => ({ ...item, id: Number(item.id) })),
    messageCount: Number(row.message_count) || 0,
    lastMessageDate: Number(row.last_message_date) || null,
    createdAt: Number(row.created_at) || null,
    updatedAt: Number(row.updated_at) || null,
  };
}

function listContacts({ query = '', groupId = null, limit = 500 } = {}) {
  const cleanQuery = String(query || '').trim().toLowerCase();
  const where = [];
  const params = {};
  if (cleanQuery) {
    where.push(`(lower(c.display_name) LIKE @query OR lower(c.first_name) LIKE @query
      OR lower(c.last_name) LIKE @query OR lower(c.company) LIKE @query
      OR EXISTS(SELECT 1 FROM contact_emails ce WHERE ce.contact_id=c.id AND ce.email LIKE @query))`);
    params.query = `%${cleanQuery}%`;
  }
  if (Number.isInteger(Number(groupId)) && Number(groupId) > 0) {
    where.push('EXISTS(SELECT 1 FROM contact_group_members gm WHERE gm.contact_id=c.id AND gm.group_id=@groupId)');
    params.groupId = Number(groupId);
  }
  params.limit = Math.max(1, Math.min(5000, Number(limit) || 500));
  const sql = contactSelectSql(where.length ? `WHERE ${where.join(' AND ')}` : '',
    'ORDER BY c.favorite DESC, c.display_name COLLATE NOCASE, c.id LIMIT @limit');
  return db.prepare(sql).all(params).map(decorateContact);
}

function getContact(id) {
  return decorateContact(db.prepare(contactSelectSql('WHERE c.id=?')).get(Number(id)));
}

function findContactByEmail(email) {
  const normalized = normalizeContactEmail(email);
  if (!normalized) return null;
  return decorateContact(db.prepare(contactSelectSql(`
    WHERE EXISTS(SELECT 1 FROM contact_emails ce WHERE ce.contact_id=c.id AND ce.email=?)`
  )).get(normalized));
}

function ensureContactGroup(name, color = '#4f8bd6') {
  const clean = String(name || '').trim().slice(0, 80);
  if (!clean) return null;
  db.prepare('INSERT OR IGNORE INTO contact_groups(name,color) VALUES(?,?)').run(clean, color);
  return db.prepare('SELECT * FROM contact_groups WHERE name=? COLLATE NOCASE').get(clean);
}

function saveContact(input, id = null) {
  const contact = normalizeContactInput(input);
  const now = Date.now();
  return db.transaction(() => {
    let contactId = Number(id);
    if (Number.isInteger(contactId) && contactId > 0) {
      const exists = db.prepare('SELECT id FROM contacts WHERE id=?').get(contactId);
      if (!exists) throw new Error('Contact introuvable');
      db.prepare(`UPDATE contacts SET display_name=?, first_name=?, last_name=?, company=?,
        job_title=?, phone=?, mobile=?, postal_address=?, birthday=?, notes=?, avatar_data=?, trusted=?,
        favorite=?, preferred_account_id=?, updated_at=? WHERE id=?`).run(
          contact.displayName, contact.firstName, contact.lastName, contact.company,
          contact.jobTitle, contact.phone, contact.mobile, contact.postalAddress,
          contact.birthday, contact.notes, contact.avatarData, contact.trusted ? 1 : 0,
          contact.favorite ? 1 : 0, contact.preferredAccountId, now, contactId
        );
      db.prepare('DELETE FROM contact_emails WHERE contact_id=?').run(contactId);
      db.prepare('DELETE FROM contact_group_members WHERE contact_id=?').run(contactId);
    } else {
      const result = db.prepare(`INSERT INTO contacts(display_name,first_name,last_name,company,
        job_title,phone,mobile,postal_address,birthday,notes,avatar_data,trusted,favorite,
        preferred_account_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          contact.displayName, contact.firstName, contact.lastName, contact.company,
          contact.jobTitle, contact.phone, contact.mobile, contact.postalAddress,
          contact.birthday, contact.notes, contact.avatarData, contact.trusted ? 1 : 0,
          contact.favorite ? 1 : 0, contact.preferredAccountId, now, now
        );
      contactId = Number(result.lastInsertRowid);
    }

    const emailInsert = db.prepare(`INSERT INTO contact_emails(contact_id,email,label,is_primary)
                                    VALUES(?,?,?,?)`);
    for (const email of contact.emails) {
      try { emailInsert.run(contactId, email.email, email.label, email.isPrimary ? 1 : 0); }
      catch (error) {
        if (String(error.code || '').includes('SQLITE_CONSTRAINT')) {
          const owner = db.prepare('SELECT contact_id FROM contact_emails WHERE email=?').get(email.email);
          throw new Error(owner?.contact_id === contactId
            ? `Adresse déjà présente : ${email.email}`
            : `Cette adresse appartient déjà à un autre contact : ${email.email}`);
        }
        throw error;
      }
    }

    const memberInsert = db.prepare('INSERT OR IGNORE INTO contact_group_members(contact_id,group_id) VALUES(?,?)');
    for (const groupName of contact.groupNames) {
      const group = ensureContactGroup(groupName);
      if (group) memberInsert.run(contactId, group.id);
    }
    return getContact(contactId);
  })();
}

function removeContact(id) {
  return db.prepare('DELETE FROM contacts WHERE id=?').run(Number(id));
}

function listContactGroups() {
  return db.prepare(`SELECT g.*, COUNT(cgm.contact_id) AS contact_count
                       FROM contact_groups g
                       LEFT JOIN contact_group_members cgm ON cgm.group_id=g.id
                      GROUP BY g.id ORDER BY g.name COLLATE NOCASE`).all().map(row => ({
    id: Number(row.id), name: row.name, color: row.color,
    contactCount: Number(row.contact_count) || 0,
  }));
}

function removeContactGroup(id) {
  return db.prepare('DELETE FROM contact_groups WHERE id=?').run(Number(id));
}

function suggestContacts(query, limit = 12) {
  const clean = String(query || '').trim().toLowerCase();
  if (!clean) return [];
  const max = Math.max(1, Math.min(50, Number(limit) || 12));
  const contacts = db.prepare(`SELECT c.id, c.display_name, c.company, c.favorite, c.trusted, c.preferred_account_id, c.avatar_data,
                            ce.email, ce.label, ce.is_primary
                       FROM contacts c JOIN contact_emails ce ON ce.contact_id=c.id
                      WHERE lower(c.display_name) LIKE @query OR ce.email LIKE @query
                         OR lower(c.company) LIKE @query
                      ORDER BY c.favorite DESC, ce.is_primary DESC,
                               c.display_name COLLATE NOCASE, ce.email
                      LIMIT @limit`).all({ query: `%${clean}%`, limit: max })
    .map(row => ({
      type: 'contact', contactId: Number(row.id), displayName: row.display_name || '', company: row.company || '',
      favorite: Boolean(row.favorite), trusted: Boolean(row.trusted), email: row.email,
      preferredAccountId: row.preferred_account_id || '', avatarData: row.avatar_data || '',
      label: row.label || '', isPrimary: Boolean(row.is_primary),
    }));

  const groups = db.prepare(`SELECT g.id, g.name, g.color,
      (SELECT group_concat(primary_email, ', ') FROM (
         SELECT COALESCE(
           (SELECT ce.email FROM contact_emails ce WHERE ce.contact_id=cgm.contact_id
             ORDER BY ce.is_primary DESC, ce.id LIMIT 1), '') AS primary_email
           FROM contact_group_members cgm WHERE cgm.group_id=g.id
      ) WHERE primary_email<>'') AS emails
    FROM contact_groups g
    WHERE lower(g.name) LIKE @query
    ORDER BY g.name COLLATE NOCASE LIMIT @limit`).all({ query: `%${clean}%`, limit: max })
    .map(row => ({
      type: 'group', groupId: Number(row.id), displayName: row.name,
      color: row.color, emails: String(row.emails || '').split(',').map(value => value.trim()).filter(Boolean),
    })).filter(row => row.emails.length);

  return [...groups, ...contacts].slice(0, max);
}

function listContactDirectory() {
  return db.prepare(`SELECT c.id, c.display_name, c.avatar_data, c.trusted,
      ce.email, ce.is_primary
    FROM contacts c
    JOIN contact_emails ce ON ce.contact_id=c.id
    ORDER BY c.id, ce.is_primary DESC, ce.id`).all().map(row => ({
      contactId: Number(row.id),
      displayName: row.display_name || '',
      avatarData: row.avatar_data || '',
      trusted: Boolean(row.trusted),
      email: row.email || '',
      isPrimary: Boolean(row.is_primary),
    }));
}

function isTrustedEmail(email) {
  const normalized = normalizeContactEmail(email);
  if (!normalized) return false;
  return Boolean(db.prepare(`SELECT 1 FROM contact_emails ce
                              JOIN contacts c ON c.id=ce.contact_id
                             WHERE ce.email=? AND c.trusted=1 LIMIT 1`).get(normalized));
}

function clearSpamForContact(contactId) {
  const emails = db.prepare('SELECT email FROM contact_emails WHERE contact_id=?').all(Number(contactId));
  if (!emails.length) return 0;
  const placeholders = emails.map(() => '?').join(',');
  return db.prepare(`UPDATE messages SET is_spam=0
                      WHERE folder_role='inbox' AND lower(from_addr) IN (${placeholders})`)
    .run(...emails.map(row => row.email)).changes;
}

function countContacts() {
  const row = db.prepare('SELECT COUNT(*) AS n, SUM(trusted) AS trusted, SUM(favorite) AS favorites FROM contacts').get();
  return { n: Number(row.n) || 0, trusted: Number(row.trusted) || 0, favorites: Number(row.favorites) || 0 };
}

// ---------- Synchronisation ----------
const getSyncState = (accountId, folder) => db.prepare(
  'SELECT * FROM sync_state WHERE account_id=? AND folder=?'
).get(accountId, folder);

function setSyncState(accountId, folder, uidValidity, lastUid, options = {}) {
  const highestModseq = options.highestModseq == null ? null : String(options.highestModseq);
  const messageCount = Math.max(0, Number(options.messageCount) || 0);
  const lastReconcile = Math.max(0, Number(options.lastReconcile) || 0);
  return db.prepare(`
    INSERT INTO sync_state(account_id, folder, uidvalidity, last_uid,
                           highest_modseq, message_count, last_reconcile)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(account_id, folder) DO UPDATE SET
      uidvalidity=excluded.uidvalidity,
      last_uid=excluded.last_uid,
      highest_modseq=COALESCE(excluded.highest_modseq, sync_state.highest_modseq),
      message_count=excluded.message_count,
      last_reconcile=CASE WHEN excluded.last_reconcile > 0
                          THEN excluded.last_reconcile ELSE sync_state.last_reconcile END
  `).run(accountId, folder, uidValidity, lastUid,
         highestModseq, messageCount, lastReconcile);
}

function countFolderMessages(accountId, folder) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM messages
                             WHERE account_id=? AND folder=?`).get(accountId, folder)?.n) || 0;
}

function listFolderUids(accountId, folder) {
  return db.prepare(`SELECT uid FROM messages WHERE account_id=? AND folder=? ORDER BY uid`)
    .all(accountId, folder).map(row => Number(row.uid)).filter(Number.isFinite);
}

function updateRemoteFlags(accountId, folder, uid, flags) {
  const values = flags instanceof Set ? flags : new Set(flags || []);
  return db.prepare(`UPDATE messages
                        SET seen=?, flagged=?, answered=?
                      WHERE account_id=? AND folder=? AND uid=?`)
    .run(values.has('\Seen') ? 1 : 0,
         values.has('\Flagged') ? 1 : 0,
         values.has('\Answered') ? 1 : 0,
         accountId, folder, Number(uid));
}

function removeMissingFolderUids(accountId, folder, serverUids) {
  const present = new Set((serverUids || []).map(Number).filter(Number.isFinite));
  const local = db.prepare(`SELECT id, eml_path, uid FROM messages
                              WHERE account_id=? AND folder=?`).all(accountId, folder);
  const missing = local.filter(row => !present.has(Number(row.uid)));
  if (!missing.length) return [];
  const removeLabels = db.prepare('DELETE FROM message_labels WHERE message_id=?');
  const removeMessage = db.prepare('DELETE FROM messages WHERE id=?');
  return db.transaction(rows => {
    for (const row of rows) {
      deleteFtsRow(row.id);
      removeLabels.run(row.id);
      removeMessage.run(row.id);
    }
    return rows;
  })(missing);
}

const clearSyncState = (accountId, folder) => db.prepare(
  'DELETE FROM sync_state WHERE account_id=? AND folder=?'
).run(accountId, folder);

module.exports = {
  init,
  close,
  get db() { return db; },
  normalizeSubject,
  fallbackThreadKey,
  resolveEmlPath,
  upsertMessage,
  indexBody,
  listMessages,
  countMessages,
  listConversations,
  countConversations,
  getConversation,
  findThreadKeyByMessageIds,
  setConversationSeen,
  search,
  getMessage,
  getMessagesByIds,
  setFlag,
  deleteMessage,
  deleteMessages,
  deleteAccountData,
  listMessagesForRetention,
  listSpamMessages,
  listMessagesByRole,
  getStatistics,
  listLabels,
  addLabel,
  updateLabel,
  removeLabel,
  tagMessage,
  untagMessage,
  tagMessages,
  untagMessages,
  labelStateForMessages,
  normalizeContactEmail,
  listContacts,
  getContact,
  findContactByEmail,
  saveContact,
  removeContact,
  listContactGroups,
  removeContactGroup,
  suggestContacts,
  listContactDirectory,
  isTrustedEmail,
  clearSpamForContact,
  countContacts,
  getSyncState,
  setSyncState,
  countFolderMessages,
  listFolderUids,
  updateRemoteFlags,
  removeMissingFolderUids,
  clearSyncState,
};
