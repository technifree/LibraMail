/**
 * LibraMail — Synchronisation et actions IMAP (imapflow)
 * Indexation incrémentale par UID. Le message MIME brut est conservé dans
 * le magasin local chiffré depuis LibraMail 0.4.0 (compatibilité .eml assurée).
 */
'use strict';
const { ImapFlow } = require('imapflow');
const mailAuth = require('./mail_auth'); // LibraMail 0.5.1 — socle d'authentification mail
const { simpleParser } = require('mailparser');
const db = require('./db');
const spam = require('./spam');
const mailStore = require('./mail_store');

const clients = new Map();
const syncClients = new Map();

// LibraMail 0.4.4 — garde-fou des connexions IDLE persistantes
const watchRetryTimers = new Map();
const watchStoppingClients = new WeakSet();
const WATCH_RETRY_MS = 5000;
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

async function yieldToEventLoop(signal) {
  await new Promise(resolve => setImmediate(resolve));
  throwIfAborted(signal);
}

function isSyncCancelled(error) {
  return error?.code === 'SYNC_CANCELLED' || error?.name === 'SyncCancelledError';
}

// LibraMail 0.4.4 — garde-fous contre les relèves IMAP bloquées.
//
// Les relèves automatiques doivent rester courtes et prévisibles. Une relève
// manuelle conserve des limites plus larges pour laisser le temps aux grosses
// boîtes ou aux connexions lentes de terminer normalement.
class SyncTimeoutError extends Error {
  constructor(message, { phase = 'operation', role = null, timeoutMs = 0 } = {}) {
    super(message);
    this.name = 'SyncTimeoutError';
    this.code = 'SYNC_TIMEOUT';
    this.phase = phase;
    this.role = role;
    this.timeoutMs = timeoutMs;
  }
}

function syncTimeoutPolicy(source = 'other') {
  switch (String(source || 'other')) {
    case 'idle':
      return { connectMs: 10000, folderMs: 15000, totalMs: 30000 };
    case 'timer':
    case 'startup':
      return { connectMs: 12000, folderMs: 18000, totalMs: 45000 };
    case 'manual':
      return { connectMs: 20000, folderMs: 45000, totalMs: 180000 };
    default:
      return { connectMs: 15000, folderMs: 30000, totalMs: 90000 };
  }
}

function runWithSyncTimeout(action, timeoutMs, makeTimeoutError, onTimeout = null) {
  const limit = Math.max(1, Number(timeoutMs) || 1);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { onTimeout?.(); } catch {}
      reject(makeTimeoutError());
    }, limit);
    timer.unref?.();

    Promise.resolve()
      .then(action)
      .then(
        value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          // Une opération IMAP interrompue peut rejeter après que le timeout a
          // déjà rendu la main. Cette rejection reste consommée ici et ne
          // devient donc pas une unhandledRejection.
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      );
  });
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


const IMAP_LOGOUT_TIMEOUT_MS = 2000;

async function closeClientGracefully(client, timeoutMs = IMAP_LOGOUT_TIMEOUT_MS) {
  if (!client) return;
  let settled = false;
  const logoutPromise = Promise.resolve()
    .then(() => client.logout())
    .catch(error => {
      if (!isExpectedCancellationError(error) && error?.code !== 'NoConnection') {
        console.warn('[LibraMail] Fermeture IMAP :', error?.message || error);
      }
    })
    .finally(() => { settled = true; });

  let timer = null;
  await Promise.race([
    logoutPromise,
    new Promise(resolve => {
      timer = setTimeout(resolve, Math.max(250, Number(timeoutMs) || IMAP_LOGOUT_TIMEOUT_MS));
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);

  // Certains serveurs gardent LOGOUT en attente alors que tout le travail utile
  // est terminé. On ne laisse plus cette politesse réseau bloquer l'interface.
  if (!settled) interruptClient(client);
}



function makeClient(account) {
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port || 993,
    secure: account.imap.secure !== false,
    auth: mailAuth.imapAuth(account),
    logger: false,
    qresync: true,
    connectionTimeout: 30000,
    socketTimeout: 90000,
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
  for (const row of rows || []) mailStore.removeMessage(row);
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
      snippet: mailStore.protectSnippet(account.id, text.slice(0, 160)),
      seen: message.flags.has('\\Seen') ? 1 : 0,
      flagged: message.flags.has('\\Flagged') ? 1 : 0,
      answered: message.flags.has('\\Answered') ? 1 : 0,
      has_attach: (parsed.attachments || []).length > 0 ? 1 : 0,
      size: message.size || 0,
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
    const descriptor = mailStore.storeMessage({ ...row, id }, message.source);
    db.setMessageStorage(id, descriptor);
    db.indexBody(id, row, text, {
      secureTokens: mailStore.searchTokens(text),
    });
    added.push(id);
    maxUid = Math.max(maxUid, Number(message.uid) || 0);

    if (added.length % 10 === 0) {
      await yieldToEventLoop(signal);
    }

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

async function syncFolders(account, jobs, dataDir, onProgress,
                           { signal = null, continueOnError = false, source = 'other' } = {}) {
  if (!account) throw new Error('Compte introuvable');
  throwIfAborted(signal);

  const policy = syncTimeoutPolicy(source);
  const syncStartedAt = Date.now();
  const deadline = syncStartedAt + policy.totalMs;
  const folderTimings = [];
  const connectTimings = [];
  const results = [];

  let client = null;

  const label = account.displayName || account.email || account.id || 'compte';
  const seconds = value => `${(Math.max(0, Number(value) || 0) / 1000).toFixed(2)}s`;
  const remainingMs = () => Math.max(0, deadline - Date.now());
  const automaticSource = ['timer', 'startup', 'idle'].includes(String(source || ''));

  const abort = () => {
    if (client) interruptClient(client);
  };
  signal?.addEventListener('abort', abort, { once: true });

  const connectClient = async () => {
    throwIfAborted(signal);

    const remaining = remainingMs();
    if (remaining <= 0) {
      throw new SyncTimeoutError(
        `Délai global de relève atteint (${seconds(policy.totalMs)})`,
        { phase: 'total', timeoutMs: policy.totalMs }
      );
    }

    const nextClient = makeClient(account);
    client = nextClient;
    syncClients.set(account.id, nextClient);

    const startedAt = Date.now();
    const budget = Math.max(1, Math.min(policy.connectMs, remaining));

    try {
      await runWithSyncTimeout(
        () => nextClient.connect(),
        budget,
        () => new SyncTimeoutError(
          `Connexion IMAP trop lente (${seconds(budget)})`,
          { phase: 'connect', timeoutMs: budget }
        ),
        () => interruptClient(nextClient)
      );

      connectTimings.push(Date.now() - startedAt);
      throwIfAborted(signal);
      return nextClient;
    } catch (error) {
      connectTimings.push(Date.now() - startedAt);

      if (syncClients.get(account.id) === nextClient) {
        syncClients.delete(account.id);
      }
      interruptClient(nextClient);
      if (client === nextClient) client = null;

      if (error?.code === 'SYNC_TIMEOUT') {
        console.warn(
          `[LibraMail][IMAP][TIMEOUT] ${label} · ${source}`
          + ` · connexion · limite ${seconds(error.timeoutMs)}`
        );
      }

      throw error;
    }
  };

  try {
    await connectClient();

    const selectedJobs = (jobs || []).filter(job =>
      Boolean(Array.isArray(job) ? job[1] : job?.folder)
    );

    for (let index = 0; index < selectedJobs.length; index++) {
      throwIfAborted(signal);

      const job = selectedJobs[index];
      const role = Array.isArray(job) ? job[0] : job.role;
      const folder = Array.isArray(job) ? job[1] : job.folder;
      if (!folder) continue;

      const remaining = remainingMs();
      if (remaining <= 0) {
        const message = `Délai global de relève atteint (${seconds(policy.totalMs)})`;
        console.warn(
          `[LibraMail][IMAP][TIMEOUT] ${label} · ${source}`
          + ` · total · limite ${seconds(policy.totalMs)}`
        );

        for (let pendingIndex = index; pendingIndex < selectedJobs.length; pendingIndex++) {
          const pending = selectedJobs[pendingIndex];
          const pendingRole = Array.isArray(pending) ? pending[0] : pending.role;
          const pendingFolder = Array.isArray(pending) ? pending[1] : pending.folder;
          results.push({
            folder: pendingFolder,
            role: pendingRole,
            added: 0,
            changed: 0,
            removed: 0,
            error: message,
            timeout: true,
            skipped: true,
          });
        }
        break;
      }

      if (!client) await connectClient();
      const activeClient = client;

      const folderStartedAt = Date.now();
      const folderBudget = Math.max(1, Math.min(policy.folderMs, remainingMs()));
      const folderController = new AbortController();
      let currentPhase = 'open';

      const propagateAbort = () => folderController.abort();
      if (signal?.aborted) folderController.abort();
      else signal?.addEventListener('abort', propagateAbort, { once: true });

      const progress = data => {
        currentPhase = String(data?.phase || currentPhase || 'operation');
        onProgress?.(data);
      };

      try {
        const result = await runWithSyncTimeout(
          () => syncFolderWithClient(
            activeClient,
            account,
            folder,
            dataDir,
            progress,
            { role, signal: folderController.signal }
          ),
          folderBudget,
          () => new SyncTimeoutError(
            `Dossier IMAP trop lent (${seconds(folderBudget)})`,
            { phase: currentPhase, role, timeoutMs: folderBudget }
          ),
          () => {
            folderController.abort();
            interruptClient(activeClient);
          }
        );

        results.push(result);
        folderTimings.push({
          role,
          ms: Date.now() - folderStartedAt,
          phase: currentPhase,
          timeout: false,
        });
      } catch (error) {
        const elapsed = Date.now() - folderStartedAt;
        const timedOut = error?.code === 'SYNC_TIMEOUT';

        folderTimings.push({
          role,
          ms: elapsed,
          phase: error?.phase || currentPhase,
          timeout: timedOut,
        });

        if (signal?.aborted) throw new SyncCancelledError();

        if (timedOut) {
          console.warn(
            `[LibraMail][IMAP][TIMEOUT] ${label} · ${source}`
            + ` · ${role} · phase ${error.phase || currentPhase}`
            + ` · limite ${seconds(error.timeoutMs)}`
          );

          if (syncClients.get(account.id) === activeClient) {
            syncClients.delete(account.id);
          }
          if (client === activeClient) client = null;

          results.push({
            folder,
            role,
            added: 0,
            changed: 0,
            removed: 0,
            error: error.message,
            timeout: true,
            phase: error.phase || currentPhase,
          });

          // Les relèves automatiques privilégient la disponibilité : après un
          // dossier bloqué, on repart sur une connexion neuve pour le suivant.
          if (!automaticSource && !continueOnError) throw error;
        } else {
          if (isSyncCancelled(error)) throw new SyncCancelledError();
          if (!continueOnError) throw error;

          results.push({
            folder,
            role,
            added: 0,
            changed: 0,
            removed: 0,
            error: error.message,
          });
        }
      } finally {
        signal?.removeEventListener('abort', propagateAbort);
      }

      await yieldToEventLoop(signal);
    }

    const totalMs = Date.now() - syncStartedAt;
    if (source === 'manual' || totalMs >= 1500) {
      const connectMs = connectTimings.reduce((sum, value) => sum + value, 0);
      const reconnectDetail = connectTimings.length > 1
        ? ` (${connectTimings.length} connexions)`
        : '';
      const detail = folderTimings
        .map(item =>
          `${item.role}:${seconds(item.ms)}`
          + (item.timeout ? `[timeout:${item.phase || 'operation'}]` : '')
        )
        .join(' · ');

      console.log(
        `[LibraMail][IMAP] ${label} · ${source}`
        + ` · connexion ${seconds(connectMs)}${reconnectDetail}`
        + (detail ? ` · ${detail}` : '')
        + ` · total ${seconds(totalMs)}`
      );
    }

    return results;
  } catch (error) {
    if (signal?.aborted || isSyncCancelled(error)) throw new SyncCancelledError();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);

    const finalClient = client;
    if (finalClient && syncClients.get(account.id) === finalClient) {
      syncClients.delete(account.id);
    }

    if (finalClient) {
      if (signal?.aborted) {
        interruptClient(finalClient);
      } else {
        // closeClientGracefully() existait déjà dans la branche actuelle et
        // borne LOGOUT à 2 secondes : on le conserve tel quel.
        await closeClientGracefully(finalClient);
      }
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
      await closeClientGracefully(client);
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
    await closeClientGracefully(client);
  }
}

// LibraMail 0.4.8 — mise à jour groupée du drapeau \Seen.
// On conserve une seule connexion et un seul verrou de boîte par dossier.
// Les UID sont découpés pour éviter une commande IMAP démesurée.
async function setSeenUids(account, folder, uids, value = true) {
  const unique = [...new Set((uids || []).map(Number)
    .filter(uid => Number.isInteger(uid) && uid > 0))];
  if (!account || !folder || !unique.length) return 0;

  const client = makeClient(account);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      for (let index = 0; index < unique.length; index += 1000) {
        const sequence = unique.slice(index, index + 1000).join(',');
        if (value) {
          await client.messageFlagsAdd(sequence, ['\\Seen'], { uid: true });
        } else {
          await client.messageFlagsRemove(sequence, ['\\Seen'], { uid: true });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await closeClientGracefully(client);
  }

  return unique.length;
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
    await closeClientGracefully(client);
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
    await closeClientGracefully(client);
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
    await closeClientGracefully(client);
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
    await closeClientGracefully(client);
  }
}

/**
 * Maintient une connexion IDLE. Le moteur central décide ensuite quand lancer
 * la synchronisation, ce qui évite les relèves concurrentes avec le minuteur.
 */
function clearWatchRetry(accountId) {
  const timer = watchRetryTimers.get(accountId);
  if (timer) clearTimeout(timer);
  watchRetryTimers.delete(accountId);
}

function isTransientWatchError(error) {
  const code = String(error?.code || '').toUpperCase();
  if ([
    'ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EPIPE',
    'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN',
  ].includes(code)) return true;
  return /timeout|timed out|connection (?:closed|lost|reset)|socket (?:closed|ended)/i
    .test(String(error?.message || ''));
}

function scheduleWatchRetry(account, onExists, error = null) {
  const accountId = account?.id;
  if (!accountId || watchRetryTimers.has(accountId) || clients.has(accountId)) return;

  const label = account.displayName || account.email || accountId;
  const timer = setTimeout(() => {
    watchRetryTimers.delete(accountId);
    if (clients.has(accountId)) return;

    watchInbox(account, onExists).catch(retryError => {
      console.warn(
        `[LibraMail][IMAP][IDLE] ${label} · reconnexion impossible : ${retryError.message}`
      );
      scheduleWatchRetry(account, onExists, retryError);
    });
  }, WATCH_RETRY_MS);

  timer.unref?.();
  watchRetryTimers.set(accountId, timer);

  console.warn(
    `[LibraMail][IMAP][IDLE] ${label}`
    + (error?.code ? ` · ${error.code}` : '')
    + ` · reconnexion dans ${(WATCH_RETRY_MS / 1000).toFixed(0)}s`
  );
}

async function watchInbox(account, onExists) {
  stopWatch(account.id);

  const client = makeClient(account);
  const accountId = account.id;
  const label = account.displayName || account.email || accountId;
  let ready = false;
  let failed = false;

  clients.set(accountId, client);

  const removeCurrent = () => {
    if (clients.get(accountId) === client) clients.delete(accountId);
  };

  const handleUnexpectedDisconnect = error => {
    if (watchStoppingClients.has(client)) {
      removeCurrent();
      return;
    }

    removeCurrent();
    if (failed) return;
    failed = true;

    console.warn(
      `[LibraMail][IMAP][IDLE] ${label} · connexion perdue`
      + (error?.code ? ` (${error.code})` : '')
      + (error?.message ? ` : ${error.message}` : '')
    );

    interruptClient(client);

    if (ready && (!error || isTransientWatchError(error))) {
      scheduleWatchRetry(account, onExists, error);
    }
  };

  client.on('error', handleUnexpectedDisconnect);
  client.on('close', () => handleUnexpectedDisconnect(null));

  try {
    await client.connect();
    const inbox = account.folderMap?.inbox || 'INBOX';
    await client.getMailboxLock(inbox).then(lock => lock.release());
    ready = true;

    client.on('exists', () => {
      try { onExists(account.id); } catch {}
    });
  } catch (error) {
    removeCurrent();
    watchStoppingClients.add(client);
    interruptClient(client);
    throw error;
  }
}

function stopWatch(accountId) {
  clearWatchRetry(accountId);

  const client = clients.get(accountId);
  if (!client) return;

  clients.delete(accountId);
  watchStoppingClients.add(client);

  closeClientGracefully(client).catch(() => {
    interruptClient(client);
  });
}

function stopAllWatches() {
  for (const accountId of [...new Set([
    ...clients.keys(),
    ...watchRetryTimers.keys(),
  ])]) {
    stopWatch(accountId);
  }
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
  setSeenUids,
  moveUids,
  deleteUids,
  emptyFolder,
  appendSentCopy,
  watchInbox,
  stopWatch,
  stopAllWatches,
};
