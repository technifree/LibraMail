/**
 * LibraMail — Synchronisation et actions IMAP (imapflow)
 * Un fichier .eml par message et indexation incrémentale par UID.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const db = require('./db');
const spam = require('./spam');

const clients = new Map();
const syncClients = new Map();
const closingClients = new WeakSet();
const interruptedConnections = new Map();

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

function isSyncCancelled(error) {
  return error?.code === 'SYNC_CANCELLED' || error?.name === 'SyncCancelledError';
}

function isExpectedCancellationError(error) {
  if (!error) return false;
  const now = Date.now();
  for (const [id, expiresAt] of interruptedConnections) {
    if (expiresAt <= now) interruptedConnections.delete(id);
  }
  const connectionId = error?._connId ? String(error._connId) : '';
  return error?.code === 'NoConnection'
    && connectionId
    && interruptedConnections.has(connectionId);
}

/**
 * Coupe une connexion IMAP au prochain tour de boucle.
 *
 * ImapFlow rejette synchroniquement les commandes/locks en attente lors de
 * close(). Si close() est lancé directement depuis l'événement AbortSignal,
 * cette rejection peut devancer le catch de l'opération async qui est en train
 * d'être interrompue et finir en unhandledRejection/uncaughtException.
 * Le setImmediate laisse d'abord l'appel controller.abort() se terminer, puis
 * la promesse de synchronisation reprend normalement la main et transforme le
 * NoConnection en SyncCancelledError. Le WeakSet évite aussi deux close()
 * concurrents (AbortSignal + cancelSync).
 */
function interruptClient(client) {
  if (!client || closingClients.has(client)) return false;
  closingClients.add(client);
  if (client.id) interruptedConnections.set(String(client.id), Date.now() + 10000);
  setImmediate(() => {
    try {
      if (client.usable !== false) client.close();
    } catch (error) {
      // Une connexion déjà tombée est équivalente à une annulation réussie.
      if (!isExpectedCancellationError(error)) {
        console.warn('[LibraMail] Fermeture IMAP interrompue :', error?.message || error);
      }
    }
  });
  return true;
}

function mailDir(dataDir, accountId, folder) {
  const dir = path.join(dataDir, 'mail', accountId, folder.replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeClient(account) {
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port || 993,
    secure: account.imap.secure !== false,
    auth: { user: account.imap.user, pass: account.imap.pass },
    logger: false,
    qresync: true,
    connectionTimeout: 45000,
    socketTimeout: 180000,
  });
}

function normalizeFolderName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function specialUseRole(value) {
  const special = String(value || '').toLowerCase();
  if (special.includes('inbox')) return 'inbox';
  if (special.includes('sent')) return 'sent';
  if (special.includes('trash')) return 'trash';
  if (special.includes('junk') || special.includes('spam')) return 'junk';
  return null;
}

function fallbackRole(name) {
  const normalized = normalizeFolderName(name);
  if (normalized === 'inbox' || normalized === 'boite de reception') return 'inbox';
  if (/^(sent|sent items|sent messages|elements envoyes|messages envoyes|envoyes)$/.test(normalized)) return 'sent';
  if (/^(trash|deleted items|deleted messages|corbeille|elements supprimes|messages supprimes)$/.test(normalized)) return 'trash';
  if (/^(junk|junk e mail|spam|indesirables|courrier indesirable)$/.test(normalized)) return 'junk';
  return null;
}

function buildFolderMap(folders) {
  const map = { inbox: 'INBOX', sent: null, trash: null, junk: null };
  for (const folder of folders || []) {
    const role = specialUseRole(folder.specialUse);
    if (role && !map[role]) map[role] = folder.path;
    if (role === 'inbox') map.inbox = folder.path;
  }
  for (const folder of folders || []) {
    const role = fallbackRole(folder.path || folder.name);
    if (role && !map[role]) map[role] = folder.path;
  }
  return map;
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

  const participants = [
    row.from_addr,
    ...(row.to_addr || '').split(','),
    account.email,
  ]
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const participantKey = [...new Set(participants)].sort().join('|');
  const subjectKey = db.normalizeSubject(row.subject);
  return {
    threadKey: `subject:${subjectKey}|${participantKey}`,
    inReplyTo,
    references,
  };
}

/**
 * Synchronisation IMAP réellement incrémentale.
 *
 * L'ancienne plage `${lastUid + 1}:*` pouvait encore demander au serveur le
 * dernier message lorsque `lastUid + 1` dépassait l'UID maximal, car une plage
 * IMAP inversée reste valide. On consulte désormais UIDNEXT et aucune source
 * de message n'est téléchargée lorsqu'il n'y a rien de nouveau.
 */
function numericBigInt(value) {
  if (value == null || value === '') return null;
  try { return BigInt(String(value)); } catch { return null; }
}

function removeLocalMessageFiles(rows) {
  for (const row of rows || []) {
    if (!row?.eml_path) continue;
    try { fs.rmSync(row.eml_path, { force: true }); } catch {}
  }
}

async function updateChangedFlags(client, account, folder, lastUid, state, signal, onProgress, role) {
  const previousModseq = numericBigInt(state?.highest_modseq);
  const currentModseq = numericBigInt(client.mailbox?.highestModseq);
  if (!previousModseq || !currentModseq || currentModseq <= previousModseq || lastUid <= 0) return 0;

  let changed = 0;
  try {
    for await (const message of client.fetch(`1:${lastUid}`, {
      uid: true,
      flags: true,
    }, { uid: true, changedSince: previousModseq })) {
      throwIfAborted(signal);
      db.updateRemoteFlags(account.id, folder, message.uid, message.flags);
      changed++;
      if (onProgress && (changed === 1 || changed % 100 === 0)) {
        onProgress({ folder, role, phase: 'changes', count: changed });
      }
    }
  } catch (error) {
    if (signal?.aborted) throw new SyncCancelledError();
    // Tous les serveurs n'activent pas CONDSTORE/QRESYNC. L'absence de cette
    // optimisation ne doit pas empêcher la récupération des nouveaux mails.
    if (/MODSEQ|CONDSTORE|QRESYNC|BAD|not supported/i.test(String(error?.message || ''))) return 0;
    throw error;
  }
  return changed;
}

async function storeNewMessages(client, account, folder, dataDir, firstUid, lastUid,
                                initialLastUid, uidValidity, state, onProgress,
                                role, signal) {
  if (lastUid < firstUid) return { added: [], maxUid: initialLastUid };
  const added = [];
  let maxUid = initialLastUid;
  const estimated = Math.max(0, lastUid - firstUid + 1);

  for await (const message of client.fetch(`${firstUid}:${lastUid}`, {
    uid: true, envelope: true, flags: true, size: true, source: true,
  }, { uid: true })) {
    throwIfAborted(signal);
    if (message.uid <= initialLastUid) continue;

    const dir = mailDir(dataDir, account.id, folder);
    const emlPath = path.join(dir, `${message.uid}.eml`);
    fs.writeFileSync(emlPath, message.source);

    const parsed = await simpleParser(message.source, { skipImageLinks: true });
    throwIfAborted(signal);
    const text = (parsed.text || '').replace(/\s+/g, ' ').trim();
    const envelope = message.envelope || {};
    const from = (envelope.from && envelope.from[0]) || {};
    const row = {
      account_id: account.id,
      folder,
      folder_role: role,
      uid: message.uid,
      message_id: envelope.messageId || parsed.messageId || null,
      subject: envelope.subject || parsed.subject || '(sans objet)',
      from_name: from.name || '',
      from_addr: from.address || '',
      to_addr: (envelope.to || []).map(address => address.address).join(', '),
      date: (envelope.date ? new Date(envelope.date) : new Date()).getTime(),
      snippet: text.slice(0, 160),
      seen: message.flags.has('\\Seen') ? 1 : 0,
      flagged: message.flags.has('\\Flagged') ? 1 : 0,
      answered: message.flags.has('\\Answered') ? 1 : 0,
      has_attach: (parsed.attachments || []).length > 0 ? 1 : 0,
      size: message.size || 0,
      eml_path: emlPath,
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
      if (decision?.action === 'allow' || db.isTrustedEmail(row.from_addr)) {
        row.is_spam = 0;
      } else if (decision?.action === 'block') {
        row.is_spam = 1;
      } else {
        const score = spam.classify(`${row.subject} ${row.from_addr} ${text}`);
        if (score > 0.92) row.is_spam = 1;
      }
    }

    db.recordSenderSeen({
      email: row.from_addr,
      name: row.from_name,
      subject: row.subject,
      date: row.date,
      isSpam: row.is_spam || role === 'junk',
    });

    const { id } = db.upsertMessage(row);
    db.indexBody(id, row, text);
    added.push(id);
    maxUid = Math.max(maxUid, Number(message.uid) || 0);

    // Un arrêt ne doit pas obliger à retraiter les milliers de messages déjà
    // enregistrés lors de la prochaine relève.
    if (added.length % 25 === 0) {
      db.setSyncState(account.id, folder, uidValidity, maxUid, {
        highestModseq: state?.highest_modseq || null,
        messageCount: db.countFolderMessages(account.id, folder),
      });
    }
    if (onProgress && (added.length === 1 || added.length % 25 === 0)) {
      onProgress({ folder, role, phase: 'download', count: added.length, total: estimated });
    }
  }
  return { added, maxUid };
}

async function reconcileFolder(client, account, folder, state, serverCount, addedCount, signal, onProgress, role) {
  const lastReconcile = Number(state?.last_reconcile) || 0;
  const previousServerCount = state?.server_count == null ? null : Math.max(0, Number(state.server_count) || 0);
  const due = Date.now() - lastReconcile > 24 * 60 * 60 * 1000;

  // Une différence permanente entre le cache local et le nombre annoncé par
  // le serveur (par exemple après une migration ancienne ou un cache partiel)
  // ne doit pas provoquer SEARCH ALL à chaque relève. On compare désormais
  // l'évolution du compteur serveur : les nouveaux UID déjà téléchargés sont
  // pris en compte et une différence restante suggère une suppression distante.
  const unexpectedCountChange = previousServerCount != null
    && serverCount !== previousServerCount + Math.max(0, Number(addedCount) || 0);
  const mustReconcile = previousServerCount == null || unexpectedCountChange || due;
  if (!mustReconcile) return { removed: 0, reconciledAt: lastReconcile };

  throwIfAborted(signal);
  if (onProgress) onProgress({ folder, role, phase: 'checking', count: 0, total: serverCount });
  const serverUids = serverCount > 0
    ? await client.search({ all: true }, { uid: true })
    : [];
  throwIfAborted(signal);
  if (!Array.isArray(serverUids)) {
    return { removed: 0, reconciledAt: lastReconcile };
  }
  const removedRows = db.removeMissingFolderUids(account.id, folder, serverUids);
  removeLocalMessageFiles(removedRows);
  return { removed: removedRows.length, reconciledAt: Date.now() };
}

async function syncFolderWithClient(client, account, folder, dataDir, onProgress,
                                    { role = 'other', signal = null } = {}) {
  if (!folder) return { folder: '', role, added: 0, changed: 0, removed: 0, skipped: true };
  throwIfAborted(signal);

  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    throwIfAborted(signal);
    const uidValidity = Number(client.mailbox.uidValidity);
    const uidNext = Math.max(1, Number(client.mailbox.uidNext) || 1);
    const lastServerUid = Math.max(0, uidNext - 1);
    const serverCount = Math.max(0, Number(client.mailbox.exists) || 0);
    const highestModseq = client.mailbox.highestModseq == null
      ? null : String(client.mailbox.highestModseq);

    let state = db.getSyncState(account.id, folder);
    if (state && Number(state.uidvalidity) !== uidValidity) {
      const obsolete = db.removeMissingFolderUids(account.id, folder, []);
      removeLocalMessageFiles(obsolete);
      db.clearSyncState(account.id, folder);
      state = null;
    }

    const lastUid = state ? Math.max(0, Number(state.last_uid) || 0) : 0;
    const changed = await updateChangedFlags(
      client, account, folder, Math.min(lastUid, lastServerUid), state,
      signal, onProgress, role
    );

    let addedIds = [];
    let maxUid = lastUid;
    if (lastServerUid > lastUid) {
      const downloaded = await storeNewMessages(
        client, account, folder, dataDir, lastUid + 1, lastServerUid,
        lastUid, uidValidity, state, onProgress, role, signal
      );
      addedIds = downloaded.added;
      maxUid = downloaded.maxUid;
    } else if (onProgress) {
      onProgress({ folder, role, phase: 'up-to-date', count: 0, total: 0 });
    }

    // UIDNEXT est monotone tant que UIDVALIDITY ne change pas. Même si le
    // dernier UID a été supprimé, mémoriser uidNext-1 évite de le redemander.
    maxUid = Math.max(maxUid, lastServerUid);
    const reconciliation = await reconcileFolder(
      client, account, folder, state, serverCount, addedIds.length, signal, onProgress, role
    );
    const finalCount = db.countFolderMessages(account.id, folder);
    db.setSyncState(account.id, folder, uidValidity, maxUid, {
      highestModseq,
      messageCount: finalCount,
      serverCount,
      lastReconcile: reconciliation.reconciledAt,
    });

    return {
      folder,
      role,
      added: addedIds.length,
      changed,
      removed: reconciliation.removed,
      checked: true,
      serverCount,
    };
  } finally {
    lock.release();
  }
}

async function syncFolders(account, jobs, dataDir, onProgress, { signal = null, continueOnError = false } = {}) {
  if (!account) throw new Error('Compte introuvable');
  throwIfAborted(signal);
  const client = makeClient(account);
  syncClients.set(account.id, client);
  const abort = () => { interruptClient(client); };
  signal?.addEventListener('abort', abort, { once: true });

  try {
    await client.connect();
    throwIfAborted(signal);
    const results = [];
    for (const job of jobs || []) {
      throwIfAborted(signal);
      const role = Array.isArray(job) ? job[0] : job.role;
      const folder = Array.isArray(job) ? job[1] : job.folder;
      if (!folder) continue;
      try {
        results.push(await syncFolderWithClient(client, account, folder, dataDir, onProgress, {
          role, signal,
        }));
      } catch (error) {
        if (signal?.aborted || isSyncCancelled(error)) throw new SyncCancelledError();
        if (!continueOnError) throw error;
        results.push({ folder, role, added: 0, changed: 0, removed: 0, error: error.message });
      }
    }
    return results;
  } catch (error) {
    if (signal?.aborted || isSyncCancelled(error)) throw new SyncCancelledError();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (syncClients.get(account.id) === client) syncClients.delete(account.id);
    if (signal?.aborted) {
      interruptClient(client);
    } else {
      await client.logout().catch(() => {});
    }
  }
}

/** Compatibilité pour les appels qui ne synchronisent qu'un seul dossier. */
async function syncFolder(account, folder, dataDir, onProgress, options = {}) {
  const [result] = await syncFolders(
    account,
    [[options.role || 'other', folder]],
    dataDir,
    onProgress,
    { signal: options.signal || null }
  );
  return result || { folder, role: options.role || 'other', added: 0, skipped: true };
}

function cancelSync(accountId = null) {
  const entries = accountId
    ? [[accountId, syncClients.get(accountId)]]
    : [...syncClients.entries()];
  let cancelled = 0;
  for (const [id, client] of entries) {
    if (!client) continue;
    interruptClient(client);
    syncClients.delete(id);
    cancelled++;
  }
  return cancelled;
}

async function listFolders(account, { signal = null } = {}) {
  if (!account) throw new Error('Compte introuvable');
  throwIfAborted(signal);
  const client = makeClient(account);
  const abort = () => { interruptClient(client); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await client.connect();
    throwIfAborted(signal);
    const tree = await client.list();
    throwIfAborted(signal);
    return tree.map(folder => ({
      path: folder.path,
      name: folder.name,
      specialUse: folder.specialUse || null,
    }));
  } catch (error) {
    if (signal?.aborted) throw new SyncCancelledError();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) {
      interruptClient(client);
    } else {
      await client.logout().catch(() => {});
    }
  }
}

async function resolveFolderMap(account, options = {}) {
  return buildFolderMap(await listFolders(account, options));
}

async function serverAction(account, folder, uid, action) {
  if (!account || !folder || !uid) return;
  const client = makeClient(account);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      switch (action.type) {
        case 'seen':   await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true }); break;
        case 'unseen': await client.messageFlagsRemove({ uid }, ['\\Seen'], { uid: true }); break;
        case 'flag':   await client.messageFlagsAdd({ uid }, ['\\Flagged'], { uid: true }); break;
        case 'unflag': await client.messageFlagsRemove({ uid }, ['\\Flagged'], { uid: true }); break;
        case 'delete': await client.messageDelete({ uid }, { uid: true }); break;
        case 'move':   await client.messageMove({ uid }, action.target, { uid: true }); break;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function moveUids(account, sourceFolder, uids, targetFolder) {
  const unique = [...new Set((uids || []).map(Number).filter(Number.isInteger))];
  if (!account || !sourceFolder || !targetFolder || !unique.length) return 0;
  const client = makeClient(account);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(sourceFolder);
    try {
      await client.messageMove(unique.join(','), targetFolder, { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return unique.length;
}

async function deleteUids(account, folder, uids) {
  const unique = [...new Set((uids || []).map(Number).filter(Number.isInteger))];
  if (!account || !folder || !unique.length) return 0;
  const client = makeClient(account);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageDelete(unique.join(','), { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return unique.length;
}

async function emptyFolder(account, folder) {
  if (!account || !folder) return 0;
  const client = makeClient(account);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const total = Number(client.mailbox.exists) || 0;
      if (total > 0) await client.messageDelete('1:*');
      return total;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function appendSentCopy(account, folder, raw, messageId = null) {
  if (!account || !folder || !raw) return { appended: false, reason: 'missing-folder' };
  const client = makeClient(account);
  await client.connect();
  try {
    let exists = [];
    if (messageId) {
      try {
        const lock = await client.getMailboxLock(folder);
        try {
          exists = await client.search({ header: { 'message-id': messageId } }, { uid: true });
        } finally {
          lock.release();
        }
      } catch {
        exists = [];
      }
    }
    if (exists.length) return { appended: false, reason: 'already-present' };
    await client.append(folder, raw, ['\\Seen'], new Date());
    return { appended: true };
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Maintient une connexion IDLE. Le moteur central décide ensuite quand lancer
 * la synchronisation, ce qui évite les relèves concurrentes avec le minuteur.
 */
async function watchInbox(account, onExists) {
  stopWatch(account.id);
  const client = makeClient(account);
  clients.set(account.id, client);
  client.on('close', () => clients.delete(account.id));
  await client.connect();
  const inbox = account.folderMap?.inbox || 'INBOX';
  await client.getMailboxLock(inbox).then(lock => lock.release());
  client.on('exists', () => {
    try { onExists(account.id); } catch {}
  });
}

function stopWatch(accountId) {
  const client = clients.get(accountId);
  if (client) {
    client.logout().catch(() => {});
    clients.delete(accountId);
  }
}

function stopAllWatches() {
  for (const accountId of [...clients.keys()]) stopWatch(accountId);
}

module.exports = {
  syncFolder,
  syncFolders,
  cancelSync,
  isSyncCancelled,
  isExpectedCancellationError,
  listFolders,
  resolveFolderMap,
  serverAction,
  moveUids,
  deleteUids,
  emptyFolder,
  appendSentCopy,
  watchInbox,
  stopWatch,
  stopAllWatches,
};
