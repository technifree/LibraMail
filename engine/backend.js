/**
 * LibraMail — Moteur Node.js portable
 * API RPC JSON locale sur WebSocket (127.0.0.1:47800).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { simpleParser } = require('mailparser');

const db = require('./lib/db');
const imap = require('./lib/imap');
const smtp = require('./lib/smtp');
const spam = require('./lib/spam');
const backup = require('./lib/backup');
const nativeDialog = require('./lib/native_dialog');

const PORT = 47800;
const APP_VERSION = '0.2.19';
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const ACCOUNTS_FILE = path.join(DATA, 'accounts.json');
const CONFIG_FILE = path.join(DATA, 'config.json');
const BACKUPS_DIR = path.join(ROOT, 'backups');
const RESTORE_STATE_FILE = path.join(ROOT, '.libramail-restore-state.json');
const RETENTION_CHECK_MS = 6 * 60 * 60 * 1000;

fs.mkdirSync(DATA, { recursive: true });

function recoverInterruptedRestore() {
  if (!fs.existsSync(RESTORE_STATE_FILE)) return;
  let state = null;
  try { state = JSON.parse(fs.readFileSync(RESTORE_STATE_FILE, 'utf8')); } catch {}
  const rollbackRoot = state?.rollbackRoot ? path.resolve(state.rollbackRoot) : '';
  const stagingRoot = state?.stagingRoot ? path.resolve(state.stagingRoot) : '';
  const safeRollback = rollbackRoot && rollbackRoot.startsWith(ROOT + path.sep);
  const safeStaging = stagingRoot && stagingRoot.startsWith(ROOT + path.sep);

  if (safeRollback && fs.existsSync(rollbackRoot)) {
    try {
      for (const name of fs.readdirSync(DATA)) {
        if (name === 'engine.log') continue;
        fs.rmSync(path.join(DATA, name), { recursive: true, force: true });
      }
      for (const name of fs.readdirSync(rollbackRoot)) {
        fs.renameSync(path.join(rollbackRoot, name), path.join(DATA, name));
      }
      console.warn('[LibraMail] Une restauration interrompue a été annulée automatiquement.');
    } catch (error) {
      console.error('[LibraMail] Impossible d’annuler la restauration interrompue :', error.message);
      throw error;
    }
  }

  if (safeRollback) fs.rmSync(rollbackRoot, { recursive: true, force: true });
  if (safeStaging) fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.rmSync(RESTORE_STATE_FILE, { force: true });
}

recoverInterruptedRestore();
db.init(DATA);

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const saveJson = (file, object) => fs.writeFileSync(file, JSON.stringify(object, null, 2));

function serializeAddressList(addressObject) {
  return (addressObject?.value || [])
    .map(item => ({
      name: String(item?.name || '').trim(),
      address: String(item?.address || '').trim(),
    }))
    .filter(item => item.address);
}

const defaultConfig = {
  defaultAccountId: null,
  locale: 'fr',
  theme: 'dark',
  layout: 'vertical',
  blockRemoteImages: true,
  conversationView: true,
  sortBy: 'date',
  sortDirection: 'desc',
  groupByDate: true,
  autoMarkRead: true,
  markReadDelaySeconds: 2,
  sidebarWidth: 240,
  listWidth: 380,
  listPaneHeight: 330,
  trustedSenders: [],
};

function normalizeAccount(account) {
  return {
    ...account,
    syncIntervalMinutes: Number.isFinite(Number(account.syncIntervalMinutes))
      ? Math.max(0, Math.min(1440, Math.round(Number(account.syncIntervalMinutes))))
      : 5,
    spamRetentionDays: Number.isFinite(Number(account.spamRetentionDays))
      ? Math.max(0, Math.min(3650, Math.round(Number(account.spamRetentionDays))))
      : 30,
    folderMap: account.folderMap && typeof account.folderMap === 'object'
      ? {
          inbox: account.folderMap.inbox || 'INBOX',
          sent: account.folderMap.sent || null,
          trash: account.folderMap.trash || null,
          junk: account.folderMap.junk || null,
        }
      : { inbox: 'INBOX', sent: null, trash: null, junk: null },
  };
}

let accounts = [];
let config = { ...defaultConfig };
const getAccount = id => accounts.find(account => account.id === id);

function migrateTrustedSenders() {
  // Conversion silencieuse de l'ancienne liste trustedSenders vers le carnet
  // d'adresses. Les adresses invalides sont simplement ignorées.
  if (!Array.isArray(config.trustedSenders) || !config.trustedSenders.length) return;
  for (const email of config.trustedSenders) {
    try {
      if (!db.findContactByEmail(email)) {
        const contact = db.saveContact({
          displayName: String(email), emails: [{ email, isPrimary: true }], trusted: true,
        });
        db.clearSpamForContact(contact.id);
      }
    } catch {}
  }
  config.trustedSenders = [];
  saveJson(CONFIG_FILE, config);
}

function loadRuntimeState() {
  accounts = loadJson(ACCOUNTS_FILE, []).map(normalizeAccount);
  config = { ...defaultConfig, ...loadJson(CONFIG_FILE, {}) };
  migrateTrustedSenders();
}

loadRuntimeState();

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
const sockets = new Set();
const syncTimers = new Map();
const activeSyncs = new Map();
const syncControllers = new Map();
let activeSyncBatch = null;
const activeCleanups = new Map();
let retentionTimer = null;
let shuttingDown = false;
let maintenanceOperation = null;
let startupSyncTriggered = false;

function broadcast(event, data) {
  const message = JSON.stringify({ event, data });
  for (const socket of sockets) {
    if (socket.readyState === 1) socket.send(message);
  }
}

function accountFoldersChanged(account, map) {
  return JSON.stringify(account.folderMap || {}) !== JSON.stringify(map || {});
}

async function ensureFolderMap(account, { force = false, signal = null } = {}) {
  if (!account) throw new Error('Compte introuvable');
  const hasUsefulMap = account.folderMap?.inbox
    && (account.folderMap.sent || account.folderMap.trash || account.folderMap.junk);
  if (!force && hasUsefulMap) return account.folderMap;

  const map = await imap.resolveFolderMap(account, { signal });
  if (accountFoldersChanged(account, map)) {
    account.folderMap = map;
    saveJson(ACCOUNTS_FILE, accounts);
  }
  return account.folderMap;
}

function publicAccount(account) {
  return {
    id: account.id,
    displayName: account.displayName,
    email: account.email,
    color: account.color,
    syncIntervalMinutes: account.syncIntervalMinutes,
    spamRetentionDays: account.spamRetentionDays,
    folders: {
      sent: Boolean(account.folderMap?.sent),
      trash: Boolean(account.folderMap?.trash),
      junk: Boolean(account.folderMap?.junk),
    },
  };
}

function accountDetails(account) {
  if (!account) throw new Error('Compte introuvable');
  return {
    ...publicAccount(account),
    imap: {
      host: account.imap?.host || '',
      port: Number(account.imap?.port) || 993,
      secure: account.imap?.secure !== false,
      user: account.imap?.user || '',
      hasPassword: Boolean(account.imap?.pass),
    },
    smtp: {
      host: account.smtp?.host || '',
      port: Number(account.smtp?.port) || 465,
      secure: account.smtp?.secure !== false,
      user: account.smtp?.user || account.imap?.user || '',
      hasPassword: Boolean(account.smtp?.pass || account.imap?.pass),
    },
  };
}

function validateAccountInput(input, existingId = null) {
  const email = String(input.email || '').trim();
  if (!email) throw new Error('Adresse e-mail obligatoire');
  if (accounts.some(account => account.id !== existingId
      && String(account.email || '').toLowerCase() === email.toLowerCase())) {
    throw new Error('Un compte utilise déjà cette adresse e-mail');
  }
  if (!String(input.imap?.host || '').trim()) throw new Error('Serveur IMAP obligatoire');
  if (!String(input.imap?.user || '').trim()) throw new Error('Identifiant IMAP obligatoire');
  if (!String(input.smtp?.host || '').trim()) throw new Error('Serveur SMTP obligatoire');
}

function localMessagePath(message, { mustExist = true } = {}) {
  if (!message) throw new Error('Message introuvable');
  const resolved = db.resolveEmlPath(DATA, message);
  if (resolved && resolved !== message.eml_path && fs.existsSync(resolved)) {
    db.db.prepare('UPDATE messages SET eml_path=? WHERE id=?').run(resolved, message.id);
    message.eml_path = resolved;
  }
  if (mustExist && (!resolved || !fs.existsSync(resolved))) {
    throw new Error(`Fichier local du message introuvable : ${resolved || '(chemin vide)'}`);
  }
  return resolved;
}

function removeLocalFiles(messages) {
  for (const message of messages || []) {
    const file = localMessagePath(message, { mustExist: false });
    if (file) fs.rm(file, { force: true }, () => {});
  }
}

function groupMessages(messages) {
  const groups = new Map();
  for (const message of messages || []) {
    const key = `${message.account_id}\u0000${message.folder}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(message);
  }
  return [...groups.values()];
}

async function syncRole(account, folder, role, source, signal = null) {
  if (!folder) return { folder: '', role, added: 0, skipped: true };
  return imap.syncFolder(account, folder, DATA, progress =>
    broadcast('sync.progress', { accountId: account.id, source, ...progress }),
  { role, signal });
}

function cancelActiveSyncs(accountId = null) {
  if (!accountId && activeSyncBatch) activeSyncBatch.cancelled = true;
  const ids = accountId ? [accountId] : [...syncControllers.keys()];
  let cancelled = 0;
  for (const id of ids) {
    const controller = syncControllers.get(id);
    if (!controller || controller.signal.aborted) continue;
    controller.abort();
    cancelled++;
  }
  // Fermer immédiatement la socket débloque aussi un FETCH ou une connexion
  // réseau qui ne répond plus.
  cancelled = Math.max(cancelled, imap.cancelSync(accountId));
  return cancelled;
}

async function syncAccount(account, source = 'manual') {
  if (!account) throw new Error('Compte introuvable');
  if (activeSyncs.has(account.id)) return activeSyncs.get(account.id);

  const controller = new AbortController();
  syncControllers.set(account.id, controller);
  const task = (async () => {
    broadcast('sync.started', { accountId: account.id, source, folder: 'all' });
    try {
      const folders = await ensureFolderMap(account, { force: source === 'manual', signal: controller.signal });
      if (controller.signal.aborted) throw Object.assign(new Error('Relève interrompue'), { code: 'SYNC_CANCELLED' });
      const jobs = [
        ['inbox', folders.inbox || 'INBOX'],
        ['sent', folders.sent],
        ['trash', folders.trash],
        ['junk', folders.junk],
      ].filter(([, folder]) => Boolean(folder));

      // Une seule connexion IMAP est utilisée pour tous les dossiers du
      // compte. Gmail n'a donc plus à subir quatre authentifications TLS à
      // chaque relève, petit cérémonial qui coûtait beaucoup pour rien.
      const results = await imap.syncFolders(
        account,
        jobs,
        DATA,
        progress => broadcast('sync.progress', { accountId: account.id, source, ...progress }),
        { signal: controller.signal, continueOnError: true }
      );
      const errors = results.filter(result => result.error)
        .map(({ role, folder, error }) => ({ role, folder, error }));
      const inboxError = errors.find(error => error.role === 'inbox');
      if (inboxError) throw new Error(inboxError.error);

      const indexed = results.reduce((total, result) => total + (Number(result.added) || 0), 0);
      const changed = results.reduce((total, result) => total + (Number(result.changed) || 0), 0);
      const removed = results.reduce((total, result) => total + (Number(result.removed) || 0), 0);
      const added = Number(results.find(result => result.role === 'inbox')?.added) || 0;
      const result = { added, indexed, changed, removed, folders: results, errors };
      broadcast('sync.done', { accountId: account.id, source, ...result });
      if (added > 0) broadcast('mail.new', { accountId: account.id, added, source });
      return result;
    } catch (error) {
      if (controller.signal.aborted || imap.isSyncCancelled?.(error) || error?.code === 'SYNC_CANCELLED') {
        const result = { cancelled: true, added: 0, indexed: 0, changed: 0, removed: 0 };
        broadcast('sync.cancelled', { accountId: account.id, source, ...result });
        return result;
      }
      broadcast('sync.error', { accountId: account.id, source, error: error.message });
      throw error;
    } finally {
      activeSyncs.delete(account.id);
      syncControllers.delete(account.id);
    }
  })();

  activeSyncs.set(account.id, task);
  return task;
}

async function syncAllAccounts(source = 'manual') {
  const batch = { id: crypto.randomUUID(), source, cancelled: false };
  activeSyncBatch = batch;
  const output = [];
  try {
    for (const account of accounts) {
      if (batch.cancelled) break;
      try {
        output.push({ accountId: account.id, ...(await syncAccount(account, source)) });
      } catch (error) {
        output.push({ accountId: account.id, error: error.message });
      }
    }
    return output;
  } finally {
    if (activeSyncBatch === batch) activeSyncBatch = null;
  }
}

function scheduleAccount(account) {
  const existing = syncTimers.get(account.id);
  if (existing) clearInterval(existing);
  syncTimers.delete(account.id);

  const minutes = Math.max(0, Number(account.syncIntervalMinutes) || 0);
  if (!minutes) return;
  const timer = setInterval(() => {
    syncAccount(account, 'timer').catch(() => {});
  }, minutes * 60 * 1000);
  timer.unref?.();
  syncTimers.set(account.id, timer);
}

function startWatch(account) {
  imap.watchInbox(account, () => {
    syncAccount(account, 'idle').catch(() => {});
  }).catch(error =>
    broadcast('sync.error', { accountId: account.id, source: 'idle', error: error.message })
  );
}

function serverActionSafe(message, action) {
  if (!message) return;
  const account = getAccount(message.account_id);
  if (account) imap.serverAction(account, message.folder, message.uid, action).catch(() => {});
}

function resolveSelection(items) {
  const messageIds = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.type === 'thread' && item.threadKey) {
      for (const message of db.getConversation(String(item.threadKey))) messageIds.add(Number(message.id));
    } else if (Number.isInteger(Number(item?.id))) {
      messageIds.add(Number(item.id));
    }
  }
  return db.getMessagesByIds([...messageIds]);
}

async function setMessageSpamState(message, isSpam) {
  if (!message) return false;
  if (isSpam && db.isTrustedEmail(message.from_addr)) {
    throw new Error('Cet expéditeur est un contact de confiance. Désactivez d’abord son statut de confiance dans le carnet d’adresses.');
  }
  const raw = fs.readFileSync(localMessagePath(message), 'utf8');
  const parsed = await simpleParser(raw);
  const corpus = `${message.subject || ''} ${message.from_addr || ''} ${parsed.text || ''}`;
  const wanted = isSpam ? 1 : 0;
  if (Number(message.is_spam) !== wanted) {
    if (isSpam) spam.train(corpus, true);
    else {
      spam.untrain(corpus, true);
      spam.train(corpus, false);
    }
    db.db.prepare('UPDATE messages SET is_spam=? WHERE id=?').run(wanted, message.id);
  }
  return true;
}

async function moveMessagesToTrash(messages, { source = 'manual' } = {}) {
  const succeededIds = [];
  const affectedAccounts = new Set();
  const errors = [];

  for (const group of groupMessages(messages)) {
    const first = group[0];
    const account = getAccount(first.account_id);
    if (!account) {
      errors.push({ accountId: first.account_id, error: 'Compte introuvable' });
      continue;
    }

    try {
      const folders = await ensureFolderMap(account);
      const uids = group.map(message => message.uid);
      if (first.folder_role === 'trash' || !folders.trash || first.folder === folders.trash) {
        await imap.deleteUids(account, first.folder, uids);
      } else {
        await imap.moveUids(account, first.folder, uids, folders.trash);
        affectedAccounts.add(account.id);
      }
      succeededIds.push(...group.map(message => message.id));
    } catch (error) {
      errors.push({ accountId: account.id, folder: first.folder, error: error.message });
    }
  }

  const removed = db.deleteMessages(succeededIds);
  removeLocalFiles(removed);

  // Une relève ciblée rend immédiatement visibles les messages déplacés dans
  // la corbeille, au lieu d'attendre le prochain minuteur.
  for (const accountId of affectedAccounts) {
    const account = getAccount(accountId);
    const trash = account?.folderMap?.trash;
    if (!account || !trash) continue;
    try { await syncRole(account, trash, 'trash', source); } catch {}
  }

  return {
    processed: removed.length,
    moved: affectedAccounts.size ? removed.length : 0,
    errors,
  };
}

async function emptyTrash({ source = 'manual' } = {}) {
  const messages = db.listMessagesByRole('trash');
  const removedIds = [];
  const errors = [];
  const localByAccountFolder = new Map();
  for (const group of groupMessages(messages)) {
    const first = group[0];
    localByAccountFolder.set(`${first.account_id}\u0000${first.folder}`, group);
  }

  for (const account of accounts) {
    let folders;
    try { folders = await ensureFolderMap(account); }
    catch (error) {
      errors.push({ accountId: account.id, error: error.message });
      continue;
    }

    const candidates = new Set();
    if (folders.trash) candidates.add(folders.trash);
    for (const group of localByAccountFolder.values()) {
      if (group[0]?.account_id === account.id) candidates.add(group[0].folder);
    }

    for (const folder of candidates) {
      try {
        await imap.emptyFolder(account, folder);
        const local = localByAccountFolder.get(`${account.id}\u0000${folder}`) || [];
        removedIds.push(...local.map(message => message.id));
        db.clearSyncState(account.id, folder);
      } catch (error) {
        errors.push({ accountId: account.id, folder, error: error.message });
      }
    }
  }

  const removed = db.deleteMessages(removedIds);
  removeLocalFiles(removed);
  return { deleted: removed.length, errors, source };
}

async function cleanupExpiredSpamForAccount(account, { source = 'retention', silent = false } = {}) {
  if (!account || !Number(account.spamRetentionDays)) return { processed: 0, disabled: true };
  if (activeCleanups.has(account.id)) return activeCleanups.get(account.id);

  const task = (async () => {
    const cutoff = Date.now() - Number(account.spamRetentionDays) * 86400000;
    const expired = db.listMessagesForRetention(account.id, cutoff);
    if (!expired.length) return { processed: 0 };
    if (!silent) broadcast('retention.started', {
      accountId: account.id,
      days: account.spamRetentionDays,
      count: expired.length,
    });
    const result = await moveMessagesToTrash(expired, { source });
    broadcast('retention.done', {
      accountId: account.id,
      days: account.spamRetentionDays,
      count: result.processed,
      errors: result.errors,
    });
    return result;
  })().catch(error => {
    broadcast('retention.error', { accountId: account.id, error: error.message });
    throw error;
  }).finally(() => activeCleanups.delete(account.id));

  activeCleanups.set(account.id, task);
  return task;
}

async function cleanupAllExpiredSpam({ silent = false } = {}) {
  const results = [];
  for (const account of accounts) {
    try { results.push(await cleanupExpiredSpamForAccount(account, { silent })); }
    catch (error) { results.push({ error: error.message }); }
  }
  return results;
}

function statsWithAccounts(options = {}) {
  const statistics = db.getStatistics(options);
  const decorateAccount = row => {
    const account = getAccount(row.account_id);
    return {
      ...row,
      displayName: account?.displayName || account?.email || row.account_id,
      email: account?.email || '',
      color: account?.color || '#8b7dd8',
    };
  };
  statistics.byAccount = statistics.byAccount.map(decorateAccount);
  statistics.largestMessages = statistics.largestMessages.map(decorateAccount);
  return statistics;
}


function stopAccountRuntime() {
  cancelActiveSyncs();
  for (const timer of syncTimers.values()) clearInterval(timer);
  syncTimers.clear();
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = null;
  imap.stopAllWatches?.();
}

function startAccountRuntime({ resolveFolders = false } = {}) {
  for (const account of accounts) {
    if (resolveFolders) initializeAccount(account).catch(() => {});
    else {
      startWatch(account);
      scheduleAccount(account);
    }
  }
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = setInterval(() => cleanupAllExpiredSpam({ silent: true }).catch(() => {}), RETENTION_CHECK_MS);
  retentionTimer.unref?.();
  setTimeout(() => cleanupAllExpiredSpam({ silent: true }).catch(() => {}), 8000).unref?.();
}

function backupTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function ensureMaintenanceAvailable() {
  if (maintenanceOperation) throw new Error('Une opération de sauvegarde ou de restauration est déjà en cours');
  if (activeSyncs.size || activeCleanups.size) {
    throw new Error('Une relève ou une opération de nettoyage est en cours. Réessayez lorsqu’elle est terminée.');
  }
}

async function withMaintenance(kind, task) {
  ensureMaintenanceAvailable();
  maintenanceOperation = kind;
  stopAccountRuntime();
  broadcast('backup.started', { kind });
  try {
    const result = await task();
    broadcast('backup.done', { kind, ...result });
    return result;
  } catch (error) {
    broadcast('backup.error', { kind, error: error.message });
    throw error;
  } finally {
    maintenanceOperation = null;
    if (!shuttingDown) startAccountRuntime({ resolveFolders: false });
  }
}

function progressBroadcaster(kind, step, { useProgressStep = false } = {}) {
  let lastSent = 0;
  return progress => {
    const now = Date.now();
    if (progress.completed !== progress.total && now - lastSent < 120) return;
    lastSent = now;
    broadcast('backup.progress', {
      kind,
      step: useProgressStep && progress.step ? progress.step : step,
      completed: Number(progress.completed) || 0,
      total: Number(progress.total) || 0,
      name: progress.name || '',
    });
  };
}

async function exportCompleteBackup(targetPath, { kind = 'export', step = 'archive' } = {}) {
  const reportProgress = progressBroadcaster(kind, step, {
    useProgressStep: kind === 'export' && step === 'archive',
  });
  return backup.exportArchive({
    dataDir: DATA,
    database: db.db,
    targetPath,
    appVersion: APP_VERSION,
    onProgress: progress => {
      // Pendant la sauvegarde de sécurité précédant un import, la phase
      // « prepare » ne doit pas faire passer artificiellement la jauge à 100 %
      // avant que les milliers de fichiers soient réellement compressés.
      if (kind === 'import' && step === 'safety' && progress.step === 'prepare') return;
      reportProgress(progress);
    },
  });
}

function publicBackupInspection(inspection) {
  return {
    sourcePath: inspection.source,
    archiveSize: inspection.fileSize,
    uncompressedSize: inspection.uncompressedSize,
    fileCount: inspection.entries.length,
    manifest: inspection.manifest,
  };
}

function moveDataContents(sourceDir, targetDir, { keepEngineLog = false } = {}) {
  fs.mkdirSync(targetDir, { recursive: true });
  const names = fs.existsSync(sourceDir) ? fs.readdirSync(sourceDir) : [];
  for (const name of names) {
    if (keepEngineLog && name === 'engine.log') continue;
    fs.renameSync(path.join(sourceDir, name), path.join(targetDir, name));
  }
}

function clearDataContents(dataDir, { keepEngineLog = false } = {}) {
  if (!fs.existsSync(dataDir)) return;
  for (const name of fs.readdirSync(dataDir)) {
    if (keepEngineLog && name === 'engine.log') continue;
    fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
  }
}

async function importCompleteBackup(sourcePath) {
  const resolvedSource = path.resolve(String(sourcePath || ''));
  if (resolvedSource === DATA || resolvedSource.startsWith(DATA + path.sep)) {
    throw new Error('Déplacez la sauvegarde en dehors du dossier data avant de la restaurer');
  }
  const inspection = await backup.inspectArchive(resolvedSource);
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const safetyBackup = path.join(BACKUPS_DIR, `LibraMail-avant-restauration-${backupTimestamp()}.zip`);
  broadcast('backup.progress', { kind: 'import', step: 'safety', completed: 0, total: 1, name: path.basename(safetyBackup) });
  await exportCompleteBackup(safetyBackup, { kind: 'import', step: 'safety' });

  const stagingRoot = fs.mkdtempSync(path.join(ROOT, '.libramail-restore-'));
  const rollbackRoot = path.join(ROOT, `.libramail-rollback-${process.pid}-${Date.now()}`);
  let databaseClosed = false;
  let oldDataMoved = false;

  try {
    const extractTotal = inspection.entries.filter(entry => {
      if (!entry.name.startsWith('data/') || entry.isDirectory) return false;
      const relative = entry.name.slice('data/'.length);
      return !['engine.log', 'index.db-wal', 'index.db-shm'].includes(relative);
    }).length;
    broadcast('backup.progress', { kind: 'import', step: 'extract', completed: 0, total: extractTotal, name: '' });
    const extracted = await backup.extractArchive(resolvedSource, stagingRoot, {
      onProgress: progressBroadcaster('import', 'extract'),
    });
    broadcast('backup.progress', { kind: 'import', step: 'validate', completed: 0, total: 1, name: '' });
    await backup.validateExtractedData(extracted.dataDir);
    broadcast('backup.progress', { kind: 'import', step: 'validate', completed: 1, total: 1, name: '' });
    fs.writeFileSync(RESTORE_STATE_FILE, JSON.stringify({
      rollbackRoot,
      stagingRoot,
      sourcePath: resolvedSource,
      createdAt: new Date().toISOString(),
    }, null, 2));

    broadcast('backup.progress', { kind: 'import', step: 'apply', completed: 0, total: 1, name: '' });
    db.close();
    databaseClosed = true;
    fs.mkdirSync(rollbackRoot, { recursive: true });
    moveDataContents(DATA, rollbackRoot, { keepEngineLog: true });
    oldDataMoved = true;
    moveDataContents(extracted.dataDir, DATA);

    db.init(DATA);
    databaseClosed = false;
    loadRuntimeState();
    broadcast('backup.progress', { kind: 'import', step: 'apply', completed: 1, total: 1, name: '' });

    broadcast('backup.progress', { kind: 'import', step: 'finalize', completed: 0, total: 1, name: '' });
    fs.rmSync(rollbackRoot, { recursive: true, force: true });
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(RESTORE_STATE_FILE, { force: true });
    broadcast('backup.progress', { kind: 'import', step: 'finalize', completed: 1, total: 1, name: '' });
    return {
      restored: true,
      safetyBackupPath: safetyBackup,
      manifest: inspection.manifest,
      accounts: accounts.length,
      messages: Number(db.db.prepare('SELECT COUNT(*) FROM messages').pluck().get()) || 0,
    };
  } catch (error) {
    try {
      if (!databaseClosed) {
        db.close();
        databaseClosed = true;
      }
      if (oldDataMoved && fs.existsSync(rollbackRoot)) {
        clearDataContents(DATA, { keepEngineLog: true });
        moveDataContents(rollbackRoot, DATA);
      }
      db.init(DATA);
      databaseClosed = false;
      loadRuntimeState();
    } catch (rollbackError) {
      // Le marqueur et le dossier de retour arrière sont volontairement
      // conservés : le prochain démarrage tentera de remettre l'ancien état.
      throw new Error(`${error.message}. La restauration automatique de l’état précédent a aussi échoué : ${rollbackError.message}. La sauvegarde de sécurité se trouve dans ${safetyBackup}`);
    }
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(rollbackRoot, { recursive: true, force: true });
    fs.rmSync(RESTORE_STATE_FILE, { force: true });
    throw error;
  }
}

function normalizeExternalUrl(value) {
  let raw = String(value || '').trim()
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
  if (!raw) throw new Error('Adresse du lien vide');
  if (raw.startsWith('//')) raw = `https:${raw}`;
  else if (/^www\./i.test(raw)) raw = `https://${raw}`;

  let parsed;
  try { parsed = new URL(raw); }
  catch { throw new Error('Adresse du lien invalide'); }
  const protocol = parsed.protocol.toLowerCase();
  if (!['http:', 'https:', 'mailto:'].includes(protocol)) {
    throw new Error(`Protocole de lien interdit : ${protocol || '(absent)'}`);
  }
  if ((protocol === 'http:' || protocol === 'https:') && !parsed.hostname) {
    throw new Error('Le lien ne contient aucun domaine valide');
  }
  return parsed.href;
}

function openExternalWithSystem(value) {
  const url = normalizeExternalUrl(value);
  let command = '';
  let args = [];
  if (process.platform === 'linux') {
    command = 'xdg-open';
    args = [url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', url];
  } else {
    throw new Error(`Ouverture externe non prise en charge sur ${process.platform}`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', error => reject(new Error(`Impossible de lancer ${command} : ${error.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve({ opened: true, url });
    });
  });
}

const methods = {
  // ---------- Configuration / comptes ----------
  'config.get': async () => ({ config, accounts: accounts.map(publicAccount) }),
  'config.set': async patch => {
    config = { ...config, ...patch };
    saveJson(CONFIG_FILE, config);
    return config;
  },

  // ---------- Sauvegarde et restauration ----------
  'backup.selectExportPath': async ({ defaultName } = {}) => ({
    path: await nativeDialog.showBackupDialog({
      mode: 'save',
      defaultName,
      title: 'Enregistrer la sauvegarde complète de LibraMail',
    }),
  }),

  'backup.selectImportPath': async () => ({
    path: await nativeDialog.showBackupDialog({
      mode: 'open',
      title: 'Choisir une sauvegarde LibraMail',
    }),
  }),

  'backup.inspect': async ({ sourcePath }) =>
    publicBackupInspection(await backup.inspectArchive(sourcePath)),

  'backup.export': async ({ targetPath }) => withMaintenance('export', async () => {
    const result = await exportCompleteBackup(targetPath, { kind: 'export', step: 'archive' });
    return {
      targetPath: result.targetPath,
      archiveSize: result.archiveSize,
      fileCount: result.fileCount,
      manifest: result.manifest,
    };
  }),

  'backup.import': async ({ sourcePath }) => withMaintenance('import', async () =>
    importCompleteBackup(sourcePath)),

  'accounts.add': async input => {
    validateAccountInput(input);
    const imapPassword = String(input.imap?.pass || '');
    const smtpPassword = String(input.smtp?.pass || '') || imapPassword;
    if (!imapPassword) throw new Error('Mot de passe IMAP obligatoire');
    const account = normalizeAccount({
      id: crypto.randomUUID(),
      displayName: String(input.displayName || '').trim(),
      email: String(input.email || '').trim(),
      color: input.color || '#8b7dd8',
      imap: {
        host: String(input.imap.host || '').trim(),
        port: Number(input.imap.port) || 993,
        secure: input.imap.secure !== false,
        user: String(input.imap.user || '').trim(),
        pass: imapPassword,
      },
      smtp: {
        host: String(input.smtp.host || '').trim(),
        port: Number(input.smtp.port) || 465,
        secure: input.smtp.secure !== false,
        user: String(input.smtp.user || input.imap.user || '').trim(),
        pass: smtpPassword,
      },
      syncIntervalMinutes: input.syncIntervalMinutes ?? 5,
      spamRetentionDays: input.spamRetentionDays ?? 30,
    });
    await smtp.verify(account).catch(error => { throw new Error('SMTP : ' + error.message); });
    account.folderMap = await imap.resolveFolderMap(account)
      .catch(error => { throw new Error('IMAP : ' + error.message); });

    accounts.push(account);
    if (!config.defaultAccountId) {
      config.defaultAccountId = account.id;
      saveJson(CONFIG_FILE, config);
    }
    saveJson(ACCOUNTS_FILE, accounts);
    startWatch(account);
    scheduleAccount(account);
    return publicAccount(account);
  },

  'accounts.getDetails': async ({ id }) => accountDetails(getAccount(id)),

  'accounts.update': async input => {
    const current = getAccount(input.id);
    if (!current) throw new Error('Compte introuvable');
    if (activeSyncs.has(current.id)) throw new Error('Une relève est en cours pour ce compte. Réessayez dans quelques instants.');
    validateAccountInput(input, current.id);

    const candidate = normalizeAccount({
      ...current,
      displayName: String(input.displayName || '').trim(),
      email: String(input.email || '').trim(),
      color: input.color || current.color || '#8b7dd8',
      imap: {
        host: String(input.imap.host || '').trim(),
        port: Number(input.imap.port) || 993,
        secure: input.imap.secure !== false,
        user: String(input.imap.user || '').trim(),
        pass: String(input.imap.pass || '') || current.imap?.pass || '',
      },
      smtp: {
        host: String(input.smtp.host || '').trim(),
        port: Number(input.smtp.port) || 465,
        secure: input.smtp.secure !== false,
        user: String(input.smtp.user || input.imap.user || '').trim(),
        pass: String(input.smtp.pass || '') || current.smtp?.pass || current.imap?.pass || '',
      },
      syncIntervalMinutes: input.syncIntervalMinutes ?? current.syncIntervalMinutes,
      spamRetentionDays: input.spamRetentionDays ?? current.spamRetentionDays,
    });

    await smtp.verify(candidate).catch(error => { throw new Error('SMTP : ' + error.message); });
    candidate.folderMap = await imap.resolveFolderMap(candidate)
      .catch(error => { throw new Error('IMAP : ' + error.message); });

    imap.stopWatch(current.id);
    const timer = syncTimers.get(current.id);
    if (timer) clearInterval(timer);
    syncTimers.delete(current.id);
    const index = accounts.findIndex(account => account.id === current.id);
    accounts[index] = candidate;
    saveJson(ACCOUNTS_FILE, accounts);
    startWatch(candidate);
    scheduleAccount(candidate);
    cleanupExpiredSpamForAccount(candidate, { source: 'settings', silent: true }).catch(() => {});
    return publicAccount(candidate);
  },

  'accounts.remove': async ({ id }) => {
    const account = getAccount(id);
    if (!account) throw new Error('Compte introuvable');
    if (activeSyncs.has(id)) throw new Error('Une relève est en cours pour ce compte. Réessayez dans quelques instants.');
    imap.stopWatch(id);
    const timer = syncTimers.get(id);
    if (timer) clearInterval(timer);
    syncTimers.delete(id);

    const localMessages = db.deleteAccountData(id);
    removeLocalFiles(localMessages);
    fs.rm(path.join(DATA, 'mail', id), { recursive: true, force: true }, () => {});

    accounts = accounts.filter(item => item.id !== id);
    if (config.signatureProfiles?.[id]) {
      const signatureProfiles = { ...config.signatureProfiles };
      delete signatureProfiles[id];
      config.signatureProfiles = signatureProfiles;
    }
    if (config.defaultAccountId === id) config.defaultAccountId = accounts[0]?.id || null;
    saveJson(ACCOUNTS_FILE, accounts);
    saveJson(CONFIG_FILE, config);
    return { accounts: accounts.map(publicAccount), defaultAccountId: config.defaultAccountId };
  },

  'accounts.setDefault': async ({ id }) => {
    config.defaultAccountId = id;
    saveJson(CONFIG_FILE, config);
    return true;
  },

  'accounts.setSyncInterval': async ({ id, minutes }) => {
    const account = getAccount(id);
    if (!account) throw new Error('Compte introuvable');
    account.syncIntervalMinutes = Math.max(0, Math.min(1440, Math.round(Number(minutes) || 0)));
    saveJson(ACCOUNTS_FILE, accounts);
    scheduleAccount(account);
    return publicAccount(account);
  },

  'accounts.setSpamRetention': async ({ id, days }) => {
    const account = getAccount(id);
    if (!account) throw new Error('Compte introuvable');
    account.spamRetentionDays = Math.max(0, Math.min(3650, Math.round(Number(days) || 0)));
    saveJson(ACCOUNTS_FILE, accounts);
    cleanupExpiredSpamForAccount(account, { source: 'settings', silent: true }).catch(() => {});
    return publicAccount(account);
  },

  'accounts.folders': async ({ id }) => imap.listFolders(getAccount(id)),

  // ---------- Synchronisation ----------
  'sync.folder': async ({ accountId }) => syncAccount(getAccount(accountId), 'manual'),
  'sync.all': async () => syncAllAccounts('manual'),
  'sync.cancel': async ({ accountId = null } = {}) => ({
    cancelled: cancelActiveSyncs(accountId ? String(accountId) : null),
  }),
  'sync.status': async () => ({
    active: [...syncControllers.keys()],
    batch: Boolean(activeSyncBatch),
  }),

  // L'interface appelle cette méthode une fois son démarrage terminé. La relève
  // initiale n'est lancée qu'une seule fois par exécution du moteur, y compris
  // si la connexion WebSocket est momentanément recréée.
  'app.ready': async () => {
    if (startupSyncTriggered) return { started: false, accounts: accounts.length };
    startupSyncTriggered = true;
    setTimeout(() => {
      if (!shuttingDown && !maintenanceOperation) {
        syncAllAccounts('startup').catch(error =>
          console.error('[LibraMail] Relève au démarrage :', error.message)
        );
      }
    }, 250).unref?.();
    return { started: true, accounts: accounts.length };
  },

  // ---------- Listes / conversations / lecture ----------
  'messages.list': async params => ({
    rows: db.listMessages(params),
    counts: db.countMessages(params),
  }),
  'conversations.list': async params => ({
    rows: db.listConversations(params),
    counts: db.countConversations(params),
  }),
  'conversations.read': async ({ threadKey }) => ({
    threadKey,
    messages: db.getConversation(threadKey),
  }),
  'messages.search': async ({ query, limit, sortBy, sortDirection }) =>
    db.search(query, { limit, sortBy, sortDirection }),
  'messages.read': async ({ id }) => {
    const message = db.getMessage(id);
    if (!message) throw new Error('Message introuvable');
    const raw = fs.readFileSync(localMessagePath(message));
    const parsed = await simpleParser(raw);
    const outgoing = message.folder_role === 'sent';
    const correspondent = outgoing
      ? (parsed.to?.value?.[0] || null)
      : (parsed.from?.value?.[0] || null);
    const contactEmail = correspondent?.address
      || (outgoing ? String(message.to_addr || '').split(',')[0].trim() : message.from_addr)
      || '';
    return {
      meta: message,
      html: parsed.html || null,
      text: parsed.text || parsed.textAsHtml || '',
      correspondent: {
        name: correspondent?.name || (outgoing ? '' : message.from_name || ''),
        email: contactEmail,
        contact: db.findContactByEmail(contactEmail),
      },
      headers: {
        from: parsed.from?.text,
        fromList: serializeAddressList(parsed.from),
        replyTo: parsed.replyTo?.text,
        replyToList: serializeAddressList(parsed.replyTo),
        to: parsed.to?.text,
        toList: serializeAddressList(parsed.to),
        cc: parsed.cc?.text,
        ccList: serializeAddressList(parsed.cc),
        date: parsed.date,
        subject: parsed.subject,
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
      },
      attachments: (parsed.attachments || []).map((attachment, index) => ({
        index,
        filename: attachment.filename || `piece-jointe-${index + 1}`,
        contentType: attachment.contentType,
        size: attachment.size,
      })),
    };
  },

  // ---------- Actions ----------
  'messages.setFlag': async ({ id, flag, value }) => {
    const message = db.getMessage(id);
    if (!message) throw new Error('Message introuvable');
    db.setFlag(id, flag, value);
    serverActionSafe(message, { type: value ? flag : 'un' + flag });
    return true;
  },
  'conversations.setSeen': async ({ threadKey, value }) => {
    const messages = db.setConversationSeen(threadKey, Boolean(value));
    for (const message of messages) {
      serverActionSafe(message, { type: value ? 'seen' : 'unseen' });
    }
    return { changed: messages.length, seen: Boolean(value) };
  },
  'messages.delete': async ({ id }) => {
    const message = db.getMessage(id);
    if (!message) return { processed: 0 };
    return moveMessagesToTrash([message], { source: 'delete' });
  },
  'messages.markSpam': async ({ id, isSpam }) => {
    const message = db.getMessage(id);
    if (!message) throw new Error('Message introuvable');
    await setMessageSpamState(message, Boolean(isSpam));
    return spam.stats();
  },
  'messages.batchSetFlag': async ({ items, flag, value }) => {
    if (!['seen', 'flagged'].includes(flag)) throw new Error('Drapeau invalide');
    const messages = resolveSelection(items);
    for (const message of messages) {
      db.setFlag(message.id, flag, Boolean(value));
      serverActionSafe(message, { type: value ? flag : 'un' + flag });
    }
    return { processed: messages.length, flag, value: Boolean(value) };
  },
  'messages.batchDelete': async ({ items }) => {
    const messages = resolveSelection(items);
    return moveMessagesToTrash(messages, { source: 'batch-delete' });
  },
  'messages.batchMarkSpam': async ({ items, isSpam }) => {
    const messages = resolveSelection(items);
    let processed = 0;
    let skipped = 0;
    const errors = [];
    for (const message of messages) {
      if (['sent', 'trash'].includes(message.folder_role)) {
        skipped++;
        continue;
      }
      try {
        await setMessageSpamState(message, Boolean(isSpam));
        processed++;
      } catch (error) {
        errors.push({ id: message.id, error: error.message });
      }
    }
    return { processed, skipped, errors, stats: spam.stats() };
  },
  'spam.stats': async () => spam.stats(),
  'spam.empty': async () => {
    const messages = db.listSpamMessages();
    broadcast('folder.empty.started', { kind: 'spam', count: messages.length });
    try {
      const result = await moveMessagesToTrash(messages, { source: 'empty-spam' });
      broadcast('folder.empty.done', { kind: 'spam', count: result.processed, errors: result.errors });
      return result;
    } catch (error) {
      broadcast('folder.empty.error', { kind: 'spam', error: error.message });
      throw error;
    }
  },
  'trash.empty': async () => {
    const count = db.countMessages({ folderRole: 'trash', spam: null }).n;
    broadcast('folder.empty.started', { kind: 'trash', count });
    try {
      const result = await emptyTrash({ source: 'empty-trash' });
      broadcast('folder.empty.done', { kind: 'trash', count: result.deleted, errors: result.errors });
      return result;
    } catch (error) {
      broadcast('folder.empty.error', { kind: 'trash', error: error.message });
      throw error;
    }
  },

  // ---------- Contacts ----------
  'contacts.list': async params => ({
    rows: db.listContacts(params || {}),
    groups: db.listContactGroups(),
    counts: db.countContacts(),
  }),
  'contacts.get': async ({ id }) => db.getContact(id),
  'contacts.directory': async () => db.listContactDirectory(),
  'contacts.findByEmail': async ({ email }) => db.findContactByEmail(email),
  'contacts.suggest': async ({ query, limit }) => db.suggestContacts(query, limit),
  'contacts.save': async ({ id = null, contact }) => {
    const saved = db.saveContact(contact || {}, id);
    const clearedSpam = saved.trusted ? db.clearSpamForContact(saved.id) : 0;
    broadcast('contacts.changed', { action: id ? 'updated' : 'created', id: saved.id, clearedSpam });
    return { contact: saved, clearedSpam, counts: db.countContacts() };
  },
  'contacts.addFromMessage': async ({ messageId, trusted = true }) => {
    const message = db.getMessage(messageId);
    if (!message) throw new Error('Message introuvable');
    const outgoing = message.folder_role === 'sent';
    const email = outgoing
      ? String(message.to_addr || '').split(',').map(value => value.trim()).find(Boolean)
      : String(message.from_addr || '').trim();
    if (!email) throw new Error('Aucune adresse exploitable dans ce message');
    const existing = db.findContactByEmail(email);
    if (existing) return { contact: existing, existing: true, counts: db.countContacts() };
    const saved = db.saveContact({
      displayName: outgoing ? email : (message.from_name || email),
      emails: [{ email, label: 'E-mail', isPrimary: true }],
      trusted: Boolean(trusted),
      preferredAccountId: message.account_id,
    });
    const clearedSpam = saved.trusted ? db.clearSpamForContact(saved.id) : 0;
    broadcast('contacts.changed', { action: 'created', id: saved.id, clearedSpam });
    return { contact: saved, existing: false, clearedSpam, counts: db.countContacts() };
  },
  'contacts.remove': async ({ id }) => {
    const contact = db.getContact(id);
    if (!contact) return { removed: false, counts: db.countContacts() };
    db.removeContact(id);
    broadcast('contacts.changed', { action: 'removed', id: Number(id) });
    return { removed: true, counts: db.countContacts() };
  },
  'contacts.groups.list': async () => db.listContactGroups(),
  'contacts.groups.remove': async ({ id }) => {
    db.removeContactGroup(id);
    broadcast('contacts.changed', { action: 'group-removed', id: Number(id) });
    return db.listContactGroups();
  },

  // ---------- Statistiques ----------
  'stats.get': async params => statsWithAccounts(params || {}),

  // ---------- Étiquettes ----------
  'labels.list': async () => db.listLabels(),
  'labels.add': async ({ name, color }) => { db.addLabel(name, color); return db.listLabels(); },
  'labels.update': async ({ id, name, color }) => { db.updateLabel(id, name, color); return db.listLabels(); },
  'labels.remove': async ({ id }) => { db.removeLabel(id); return db.listLabels(); },
  'labels.ofMessage': async ({ messageId }) => db.db.prepare(`
    SELECT l.id, l.name, l.color,
           EXISTS(SELECT 1 FROM message_labels ml
                   WHERE ml.label_id = l.id AND ml.message_id = ?) AS applied
      FROM labels l ORDER BY l.name`).all(messageId),
  'labels.tag': async ({ messageId, labelId }) => { db.tagMessage(messageId, labelId); return true; },
  'labels.untag': async ({ messageId, labelId }) => { db.untagMessage(messageId, labelId); return true; },
  'labels.selectionState': async ({ items }) => {
    const messages = resolveSelection(items);
    return db.labelStateForMessages(messages.map(message => message.id));
  },
  'labels.batchSet': async ({ items, labelId, applied }) => {
    const messages = resolveSelection(items);
    const ids = messages.map(message => message.id);
    const changed = applied
      ? db.tagMessages(ids, labelId)
      : db.untagMessages(ids, labelId);
    return { processed: ids.length, changed, applied: Boolean(applied) };
  },

  // ---------- Pièces jointes ----------
  'attachments.save': async ({ messageId, index, targetPath }) => {
    const message = db.getMessage(messageId);
    if (!message) throw new Error('Message introuvable');
    const parsed = await simpleParser(fs.readFileSync(localMessagePath(message)));
    const attachment = (parsed.attachments || [])[index];
    if (!attachment) throw new Error('Pièce jointe introuvable');
    fs.writeFileSync(targetPath, attachment.content);
    return { saved: targetPath, size: attachment.size };
  },

  // ---------- Envoi ----------
  'mail.send': async ({ accountId, mail }) => {
    const account = getAccount(accountId || config.defaultAccountId);
    if (!account) throw new Error('Aucun compte expéditeur');
    const sent = await smtp.send(account, mail);
    const folders = await ensureFolderMap(account).catch(() => account.folderMap || {});
    let savedToSent = false;
    let sentCopyWarning = null;

    if (folders.sent && sent.raw) {
      try {
        const appended = await imap.appendSentCopy(account, folders.sent, sent.raw, sent.messageId);
        savedToSent = appended.appended || appended.reason === 'already-present';
        await imap.syncFolder(account, folders.sent, DATA, null, { role: 'sent' });
      } catch (error) {
        sentCopyWarning = error.message;
        broadcast('sent.copy.error', { accountId: account.id, error: error.message });
      }
    }

    return {
      messageId: sent.messageId,
      accepted: sent.accepted,
      rejected: sent.rejected,
      savedToSent,
      sentCopyWarning,
    };
  },

  // ---------- Ouverture externe sécurisée ----------
  'app.openExternal': async ({ url }) => openExternalWithSystem(url),

  // ---------- Arrêt ----------
  'app.shutdown': async () => {
    setTimeout(shutdown, 80);
    return true;
  },
};

wss.on('connection', socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('message', async buffer => {
    let request;
    try { request = JSON.parse(buffer.toString()); } catch { return; }
    const { id, method, params } = request;
    try {
      if (maintenanceOperation) {
        throw new Error(maintenanceOperation === 'import'
          ? 'Une restauration des données est en cours'
          : 'Une sauvegarde des données est en cours');
      }
      const handler = methods[method];
      if (!handler) throw new Error(`Méthode inconnue : ${method}`);
      const result = await handler(params || {});
      if (socket.readyState === 1) socket.send(JSON.stringify({ id, ok: true, result }));
    } catch (error) {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ id, ok: false, error: error.message }));
      }
    }
  });
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopAccountRuntime();
  try { db.close(); } catch {}
  for (const socket of sockets) {
    try { socket.close(); } catch {}
  }
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref?.();
}

async function initializeAccount(account) {
  try { await ensureFolderMap(account, { force: true }); } catch {}
  startWatch(account);
  scheduleAccount(account);
}

startAccountRuntime({ resolveFolders: true });

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', error => {
  console.error('[LibraMail] Erreur non interceptée :', error);
});

console.log(`[LibraMail ${APP_VERSION}] Moteur prêt sur ws://127.0.0.1:${PORT} — ${accounts.length} compte(s)`);
