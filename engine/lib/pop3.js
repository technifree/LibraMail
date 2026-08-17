/**
 * LibraMail 0.4.0 — réception POP3 locale.
 * POP3 est volontairement utilisé comme protocole de rapatriement: les messages
 * téléchargés restent dans LibraMail même s'ils disparaissent ensuite du serveur.
 */
'use strict';

const { simpleParser } = require('mailparser');
const db = require('./db');
const spam = require('./spam');
const mailStore = require('./mail_store');

class SyncCancelledError extends Error {
  constructor(message = 'Relève interrompue par l’utilisateur') {
    super(message);
    this.name = 'SyncCancelledError';
    this.code = 'SYNC_CANCELLED';
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new SyncCancelledError();
}

function extractMessageIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) return [...new Set(value.flatMap(extractMessageIds))];
  const text = String(value);
  const bracketed = text.match(/<[^>]+>/g);
  const values = bracketed || text.split(/[\s,]+/).filter(Boolean);
  return [...new Set(values.map(item => item.trim().toLowerCase()).filter(Boolean))];
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
    threadKey: db.fallbackThreadKey(row.subject, row.message_id || row.uid, row.from_addr, row.to_addr, account.id),
    inReplyTo,
    references,
  };
}

function sanitizeError(error, password = '') {
  let message = String(error?.message || error || 'Erreur POP3');
  const secret = String(password || '');
  if (secret) message = message.split(secret).join('********');
  return message.replace(/PASS\s+\S+/gi, 'PASS ********');
}

let pop3ModulePromise = null;
async function loadPop3Command() {
  // node-pop3 0.15 publie une entrée ESM fonctionnelle mais son export
  // CommonJS pointe vers des fichiers .cjs contenant encore des imports ESM.
  // Un import() depuis notre moteur CommonJS sélectionne correctement la
  // branche "import" du package sans imposer une conversion globale du moteur.
  if (!pop3ModulePromise) {
    pop3ModulePromise = import('node-pop3').then(module => module.default || module.Pop3Command || module);
  }
  return pop3ModulePromise;
}

async function makeClient(account, clientFactory = null) {
  const options = account.pop3 || {};
  if (options.secure === false) {
    throw new Error('LibraMail 0.4.0 exige SSL/TLS pour POP3 (port 995 recommandé).');
  }
  if (typeof clientFactory === 'function') return clientFactory(account);
  const Pop3Command = await loadPop3Command();
  return new Pop3Command({
    user: options.user,
    password: options.pass,
    host: options.host,
    port: Number(options.port) || 995,
    tls: true,
    timeout: 45000,
    streamReadTimeout: 180000,
    servername: options.host,
    tlsOptions: { servername: options.host },
  });
}

function addressList(parsedAddress) {
  return (parsedAddress?.value || []).map(item => item.address).filter(Boolean).join(', ');
}

async function storeRawMessage(account, raw, {
  folder = 'INBOX', role = 'inbox', uid = null, seen = 0,
} = {}) {
  const source = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''), 'utf8');
  const parsed = await simpleParser(source, { skipImageLinks: true });
  const text = (parsed.text || '').replace(/\s+/g, ' ').trim();
  const fromItem = parsed.from?.value?.[0] || {};
  const localUid = uid == null ? db.nextLocalUid(account.id, folder) : Number(uid);
  const row = {
    account_id: account.id,
    folder,
    folder_role: role,
    uid: localUid,
    message_id: parsed.messageId || null,
    subject: parsed.subject || '(sans objet)',
    from_name: fromItem.name || '',
    from_addr: fromItem.address || '',
    to_addr: addressList(parsed.to),
    date: (parsed.date ? new Date(parsed.date) : new Date()).getTime(),
    snippet: mailStore.status().available
        ? mailStore.protectSnippet(account.id, text.slice(0, 160))
        : text.slice(0, 160),
    seen: seen ? 1 : 0,
    flagged: 0,
    answered: 0,
    has_attach: (parsed.attachments || []).length > 0 ? 1 : 0,
    size: source.length,
    eml_path: '',
    is_spam: role === 'junk' ? 1 : 0,
    thread_key: '',
    in_reply_to: null,
    references_json: '[]',
  };
  const thread = buildThreadKey(parsed, row, account);
  row.thread_key = thread.threadKey;
  row.in_reply_to = thread.inReplyTo;
  row.references_json = JSON.stringify(thread.references);

  if (role === 'inbox') {
    const decision = db.spamRuleDecision(row.from_addr);
    if (decision?.action === 'allow' || db.isTrustedEmail(row.from_addr)) row.is_spam = 0;
    else if (decision?.action === 'block') row.is_spam = 1;
    else if (spam.classify(`${row.subject} ${row.from_addr} ${text}`) > 0.92) row.is_spam = 1;
  }

  db.recordSenderSeen({
    email: row.from_addr, name: row.from_name, subject: row.subject,
    date: row.date, isSpam: row.is_spam || role === 'junk',
  });
  const result = db.upsertMessage(row);
  const descriptor = mailStore.storeMessage({ ...row, id: result.id }, source);
  db.setMessageStorage(result.id, descriptor);
  db.indexBody(result.id, row, text, {
    secureTokens: mailStore.status().available ? mailStore.searchTokens(text) : null,
  });
  return { id: result.id, uid: localUid, parsed, size: source.length };
}

async function verify(account) {
  const client = await makeClient(account);
  try {
    await client.UIDL();
    await client.QUIT();
    return true;
  } catch (error) {
    try { await client.QUIT(); } catch {}
    throw new Error(sanitizeError(error, account.pop3?.pass));
  }
}

async function syncAccount(account, dataDir, onProgress, { signal = null, clientFactory = null } = {}) {
  void dataDir; // le magasin chiffré connaît déjà le dossier data
  throwIfAborted(signal);
  const client = await makeClient(account, clientFactory);
  const deletePolicy = String(account.pop3?.deletePolicy || 'keep');
  const deleteAfterDays = Math.max(1, Number(account.pop3?.deleteAfterDays) || 7);
  const storageIsEncrypted = mailStore.status().available;
  const warnings = [];
  if (deletePolicy !== 'keep' && !storageIsEncrypted) {
    warnings.push('Suppression POP3 côté serveur suspendue : le coffre-fort système et le stockage chiffré doivent être disponibles.');
  }
  const effectiveDeletePolicy = storageIsEncrypted ? deletePolicy : 'keep';
  const pendingDeletes = new Set();
  let quitSucceeded = false;
  try {
    const uidRows = await client.UIDL();
    throwIfAborted(signal);
    if (!Array.isArray(uidRows)) throw new Error('Le serveur POP3 ne fournit pas UIDL; synchronisation sûre impossible.');
    const server = uidRows
      .map(item => ({ number: Number(item?.[0]), uidl: String(item?.[1] || '') }))
      .filter(item => Number.isInteger(item.number) && item.number > 0 && item.uidl);
    const stateRows = db.getPop3State(account.id);
    const state = new Map(stateRows.map(item => [String(item.uidl), item]));
    const newItems = server.filter(item => !state.has(item.uidl));
    let added = 0;

    for (const item of newItems) {
      throwIfAborted(signal);
      onProgress?.({ folder: 'INBOX', role: 'inbox', phase: 'download', count: added, total: newItems.length });
      const raw = await client.RETR(item.number);
      throwIfAborted(signal);
      const stored = await storeRawMessage(account, raw, { folder: 'INBOX', role: 'inbox', seen: 0 });
      db.setPop3State(account.id, item.uidl, { messageId: stored.id, downloadedAt: Date.now() });
      state.set(item.uidl, db.getPop3StateByUidl(account.id, item.uidl));
      added++;
    }

    if (effectiveDeletePolicy === 'immediate') {
      // Réessaie également une suppression dont un précédent QUIT aurait
      // échoué : le message est déjà local, il ne sera donc pas téléchargé
      // une seconde fois mais la politique demandée reste appliquée.
      for (const item of server) {
        throwIfAborted(signal);
        const local = state.get(item.uidl);
        if (!local || Number(local.server_deleted_at) > 0) continue;
        await client.command('DELE', item.number);
        pendingDeletes.add(item.uidl);
      }
    } else if (effectiveDeletePolicy === 'after_days') {
      const cutoff = Date.now() - deleteAfterDays * 86400000;
      for (const item of server) {
        throwIfAborted(signal);
        const local = state.get(item.uidl);
        if (!local || Number(local.server_deleted_at) > 0 || Number(local.downloaded_at) > cutoff) continue;
        await client.command('DELE', item.number);
        pendingDeletes.add(item.uidl);
      }
    }

    await client.QUIT();
    quitSucceeded = true;
    for (const uidl of pendingDeletes) db.markPop3ServerDeleted(account.id, uidl);
    onProgress?.({ folder: 'INBOX', role: 'inbox', phase: 'up-to-date', count: added, total: newItems.length });
    return {
      added,
      indexed: added,
      changed: 0,
      removed: 0,
      deletedFromServer: pendingDeletes.size,
      folders: [{ folder: 'INBOX', role: 'inbox', added, changed: 0, removed: 0 }],
      errors: warnings,
    };
  } catch (error) {
    if (signal?.aborted) throw new SyncCancelledError();
    if (!quitSucceeded) {
      // QUIT valide les DELE. En cas d'erreur nous ne marquons jamais les
      // messages comme supprimés côté serveur: le prochain passage revalidera.
      try { await client.QUIT(); } catch {}
    }
    throw new Error(sanitizeError(error, account.pop3?.pass));
  }
}

function cancelSync() {
  // node-pop3 ne fournit pas d'API publique d'interruption de socket. Le signal
  // est vérifié entre chaque commande et les timeouts réseau restent bornés.
  return 0;
}

module.exports = {
  verify,
  syncAccount,
  storeRawMessage,
  cancelSync,
  SyncCancelledError,
};
