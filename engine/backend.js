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
const outbox = require('./lib/outbox');
const backup = require('./lib/backup');
const iconCache = require('./lib/icon_cache');
const nativeDialog = require('./lib/native_dialog');
const calendarImport = require('./lib/calendar_import');
const calendarSubscriptions = require('./lib/calendar_subscriptions');
const credentialStore = require('./lib/credential_store');

const PORT = 47800;
const APP_VERSION = '0.3.8';
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const ACCOUNTS_FILE = path.join(DATA, 'accounts.json');
const CONFIG_FILE = path.join(DATA, 'config.json');
const BACKUPS_DIR = path.join(ROOT, 'backups');
const RESTORE_STATE_FILE = path.join(ROOT, '.libramail-restore-state.json');
const RETENTION_CHECK_MS = 6 * 60 * 60 * 1000;
const OUTBOX_CHECK_MS = 30 * 1000;
const CALENDAR_SUBSCRIPTION_CHECK_MS = 60 * 1000;
const RUNTIME_DATA_FILES = new Set(['engine.log', 'engine.stdout.log', 'engine.stderr.log', 'engine-startup.log']);

function isRuntimeDataFile(name) {
  return RUNTIME_DATA_FILES.has(String(name || '').replace(/\\/g, '/'));
}

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
        if (isRuntimeDataFile(name)) continue;
        fs.rmSync(path.join(DATA, name), { recursive: true, force: true });
      }
      for (const name of fs.readdirSync(rollbackRoot)) {
        if (isRuntimeDataFile(name)) continue;
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
outbox.init(db.db, DATA);

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const saveJson = (file, object) => fs.writeFileSync(file, JSON.stringify(object, null, 2));
const saveAccounts = () => saveJson(ACCOUNTS_FILE, accounts.map(credentialStore.serialize));

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

function normalizeLogoData(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length > 400000) return '';
  return /^data:image\/(?:png|jpe?g|webp|svg\+xml);base64,/i.test(raw) ? raw : '';
}


function domainFromEmail(value) {
  const match = String(value || '').trim().toLowerCase().match(/@([^>\s]+)$/);
  return match ? match[1].replace(/^www\./, '') : '';
}

function providerKeyForAccount(account = {}) {
  const email = String(account.email || '').toLowerCase();
  const domain = domainFromEmail(email);
  const host = `${account.imap?.host || ''} ${account.smtp?.host || ''}`.toLowerCase();
  const source = `${email} ${domain} ${host}`;
  if (/gmail|googlemail/.test(source)) return 'gmail';
  if (/outlook|hotmail|live\.com|office365|microsoft/.test(source)) return 'outlook';
  if (/yahoo/.test(source)) return 'yahoo';
  if (/icloud|me\.com|mac\.com/.test(source)) return 'icloud';
  if (/proton/.test(source)) return 'proton';
  if (/laposte\.net/.test(source)) return 'laposte';
  if (/free\.fr/.test(source)) return 'free';
  if (/orange|wanadoo/.test(source)) return 'orange';
  if (/sfr\.fr/.test(source)) return 'sfr';
  if (/ovh|ovhcloud/.test(source)) return 'ovh';
  return '';
}

function normalizeAccount(account) {
  return {
    ...account,
    logoData: normalizeLogoData(account.logoData),
    providerKey: providerKeyForAccount(account),
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
  const rawAccounts = loadJson(ACCOUNTS_FILE, []).map(normalizeAccount);
  let migrated = false;
  accounts = rawAccounts.map(account => {
    try {
      if (account.credentials?.store === 'system') return credentialStore.hydrate(account);
      const result = credentialStore.migrateLegacy(account);
      migrated = migrated || result.migrated;
      return result.account;
    } catch (error) {
      account._credentialWarning = error.message;
      console.warn(`[LibraMail] Compte ${account.email || account.id} : ${error.message}. Le mot de passe existant n'a pas été supprimé.`);
      return account;
    }
  });
  if (migrated) {
    saveAccounts();
    console.log('[LibraMail] Les mots de passe existants ont été migrés vers le coffre-fort système.');
  }
  config = { ...defaultConfig, ...loadJson(CONFIG_FILE, {}) };
  migrateTrustedSenders();
}

loadRuntimeState();

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
const sockets = new Set();
const syncTimers = new Map();
const activeSyncs = new Map();
const syncControllers = new Map();
const syncCooldownUntil = new Map();
const SYNC_CANCEL_COOLDOWN_MS = 60 * 1000;
let activeSyncBatch = null;
const activeCleanups = new Map();
let retentionTimer = null;
let scheduledSendTimer = null;
let scheduledSendBusy = false;
let calendarSubscriptionTimer = null;
let calendarSubscriptionSyncBusy = false;
let shuttingDown = false;
let maintenanceOperation = null;
let startupSyncTriggered = false;
let serverReady = false;

wss.on('listening', () => {
  serverReady = true;
  console.log(`[LibraMail ${APP_VERSION}] Moteur prêt sur ws://127.0.0.1:${PORT} — ${accounts.length} compte(s)`);
});

wss.on('error', error => {
  console.error('[LibraMail] Impossible de démarrer le serveur local :', error);
  if (!serverReady || error?.code === 'EADDRINUSE') {
    try { db.close(); } catch {}
    process.exit(error?.code === 'EADDRINUSE' ? 98 : 1);
  }
});

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
    saveAccounts();
  }
  return account.folderMap;
}

function publicAccount(account) {
  return {
    id: account.id,
    displayName: account.displayName,
    email: account.email,
    color: account.color,
    logoData: normalizeLogoData(account.logoData),
    providerKey: providerKeyForAccount(account),
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

function isCalendarAttachment(attachment = {}) {
  const contentType = String(attachment.contentType || '').toLowerCase();
  const filename = String(attachment.filename || '').toLowerCase();
  return contentType === 'text/calendar'
    || contentType === 'text/x-vcalendar'
    || contentType === 'application/ics'
    || /\.(ics|ical|vcs)$/.test(filename);
}

function calendarAttachmentFilename(attachment = {}, index = 0) {
  const filename = String(attachment.filename || '').trim();
  if (filename) return filename;
  return `invitation-${Number(index) + 1}.ics`;
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
  const ids = accountId ? [accountId] : [...new Set([
    ...syncControllers.keys(),
    ...activeSyncs.keys(),
  ])];
  const cooldownUntil = Date.now() + SYNC_CANCEL_COOLDOWN_MS;
  if (accountId) syncCooldownUntil.set(accountId, cooldownUntil);
  else for (const account of accounts) syncCooldownUntil.set(account.id, cooldownUntil);

  let cancelled = 0;
  for (const id of ids) {
    const controller = syncControllers.get(id);
    if (!controller || controller.signal.aborted) continue;
    controller.abort();
    cancelled++;
  }
  // Fermer immédiatement la socket débloque aussi un FETCH ou une connexion
  // réseau qui ne répond plus. Le court délai anti-redémarrage ci-dessus évite
  // qu'IDLE ou le minuteur relancent aussitôt la relève que l'utilisateur vient
  // volontairement d'interrompre.
  cancelled = Math.max(cancelled, imap.cancelSync(accountId));
  return cancelled;
}

function automaticSyncCoolingDown(accountId) {
  const until = Number(syncCooldownUntil.get(accountId)) || 0;
  if (!until) return false;
  if (Date.now() >= until) {
    syncCooldownUntil.delete(accountId);
    return false;
  }
  return true;
}

async function syncAccount(account, source = 'manual') {
  if (!account) throw new Error('Compte introuvable');
  if (source === 'manual') syncCooldownUntil.delete(account.id);
  else if (automaticSyncCoolingDown(account.id)) {
    return { skipped: true, cooldown: true, added: 0, indexed: 0, changed: 0, removed: 0 };
  }
  if (activeSyncs.has(account.id)) return activeSyncs.get(account.id);

  const controller = new AbortController();
  syncControllers.set(account.id, controller);
  const task = (async () => {
    broadcast('sync.started', { accountId: account.id, source, folder: 'all' });
    try {
      const folders = await ensureFolderMap(account, { force: false, signal: controller.signal });
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

async function setMessageSpamState(message, isSpam, { persistSenderRule = false } = {}) {
  if (!message) return false;
  const decision = db.spamRuleDecision(message.from_addr);
  if (isSpam && (decision?.action === 'allow' || db.isTrustedEmail(message.from_addr))) {
    throw new Error('Cet expéditeur est autorisé. Retirez-le d’abord des expéditeurs autorisés ou du carnet de confiance.');
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
    db.recordSenderSeen({
      email: message.from_addr,
      name: message.from_name,
      subject: message.subject,
      date: message.date,
      isSpam: wanted,
    });
  }
  if (persistSenderRule && String(message.from_addr || '').trim()) {
    const senderAddress = String(message.from_addr).trim().toLowerCase();
    const automaticRulePrefix = 'LibraMail:manual-spam:';
    const rules = db.listSpamRules();
    const existingRule = rules.find(rule =>
      rule.kind === 'email' && String(rule.value || '').toLowerCase() === senderAddress
    );
    if (isSpam) {
      let rule = existingRule;
      const isExistingAutomatic = String(existingRule?.notes || '').startsWith(automaticRulePrefix);
      if (!existingRule || existingRule.action !== 'block' || isExistingAutomatic) {
        const previous = existingRule && !isExistingAutomatic
          ? {
              action: existingRule.action,
              label: existingRule.label || '',
              notes: existingRule.notes || '',
            }
          : null;
        const encodedPrevious = Buffer.from(JSON.stringify(previous), 'utf8').toString('base64');
        rule = db.saveSpamRule({
          kind: 'email',
          value: senderAddress,
          action: 'block',
          label: 'Déclaration manuelle',
          notes: automaticRulePrefix + encodedPrevious,
        });
      }
      const changed = db.applySpamRuleToExistingMessages(rule);
      broadcast('spam.rules.updated', { rule, changed, automatic: true });
    } else {
      const automaticRule = existingRule &&
        existingRule.action === 'block' &&
        String(existingRule.notes || '').startsWith(automaticRulePrefix)
        ? existingRule
        : null;
      if (automaticRule) {
        const encodedPrevious = String(automaticRule.notes).slice(automaticRulePrefix.length);
        let previous = null;
        try {
          previous = JSON.parse(Buffer.from(encodedPrevious, 'base64').toString('utf8'));
        } catch {}
        db.removeSpamRule(automaticRule.id);
        let restoredRule = null;
        if (previous && ['allow', 'block'].includes(previous.action)) {
          restoredRule = db.saveSpamRule({
            kind: 'email',
            value: senderAddress,
            action: previous.action,
            label: previous.label || '',
            notes: previous.notes || '',
          });
        }
        broadcast('spam.rules.updated', {
          removedId: automaticRule.id,
          restoredRule,
          automatic: true,
        });
      }
    }
  }
  return true;
}
async function resolveSenderIconsForEmails(emails = []) {
  const unique = [...new Set((Array.isArray(emails) ? emails : [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean))].slice(0, 80);
  const result = {};
  for (const email of unique) {
    const contact = db.findContactByEmail(email);
    if (contact?.avatarData) {
      result[email] = { email, iconData: contact.avatarData, source: 'contact' };
      continue;
    }
    result[email] = await iconCache.resolveSenderIcon({ email, db, dataDir: DATA });
  }
  return result;
}

async function moveMessagesToTrash(messages, { source = 'manual', onProgress = null } = {}) {
  const total = Array.isArray(messages) ? messages.length : 0;
  let completed = 0;
  const succeededIds = [];
  const affectedAccounts = new Set();
  const errors = [];

  for (const group of groupMessages(messages)) {
    const first = group[0];
    const account = getAccount(first.account_id);
    if (!account) {
      errors.push({ accountId: first.account_id, error: 'Compte introuvable' });
      completed += group.length;
      if (typeof onProgress === 'function') onProgress({ completed, total });
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
    } finally {
      completed += group.length;
      if (typeof onProgress === 'function') onProgress({ completed, total });
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



// LibraMail 0.2.25 — restauration des messages supprimés par inadvertance.
// Faute de métadonnée historique fiable sur le dossier d'origine, le message
// est replacé dans la boîte de réception de son compte.


// LibraMail 0.2.25 v2 — une restauration demandée sur un message concerne
// tous les messages de la même conversation encore présents dans la corbeille.
function resolveTrashRestoreSelection(items) {
  const messageIds = new Set();

  const includeRows = rows => {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row?.folder_role === 'trash' && Number.isInteger(Number(row.id))) {
        messageIds.add(Number(row.id));
      }
    }
  };

  const includeMessageConversation = message => {
    if (!message) return;
    const threadKey = String(message.thread_key || '').trim();
    if (threadKey) includeRows(db.getConversation(threadKey));
    else includeRows([message]);
  };

  for (const item of Array.isArray(items) ? items : []) {
    if (item?.type === 'thread' && item.threadKey) {
      includeRows(db.getConversation(String(item.threadKey)));
      continue;
    }
    const id = Number(item?.id);
    if (Number.isInteger(id)) includeMessageConversation(db.getMessage(id));
  }

  return db.getMessagesByIds([...messageIds])
    .filter(message => message?.folder_role === 'trash');
}

async function restoreMessagesFromTrash(messages, { source = 'manual', onProgress = null } = {}) {
  const requested = Array.isArray(messages) ? messages : [];
  const eligible = requested.filter(message => message?.folder_role === 'trash');
  const total = eligible.length;
  let completed = 0;
  const succeededIds = [];
  const affectedAccounts = new Set();
  const errors = [];

  for (const group of groupMessages(eligible)) {
    const first = group[0];
    const account = getAccount(first.account_id);
    if (!account) {
      errors.push({ accountId: first.account_id, error: 'Compte introuvable' });
      completed += group.length;
      if (typeof onProgress === 'function') onProgress({ completed, total });
      continue;
    }
    try {
      const folders = await ensureFolderMap(account);
      const inbox = folders.inbox || 'INBOX';
      if (!first.folder) throw new Error('Dossier de corbeille introuvable');
      if (first.folder === inbox) throw new Error('Le message se trouve déjà dans la boîte de réception');
      await imap.moveUids(account, first.folder, group.map(message => message.uid), inbox);
      succeededIds.push(...group.map(message => message.id));
      affectedAccounts.add(account.id);
    } catch (error) {
      errors.push({ accountId: account.id, folder: first.folder, error: error.message });
    } finally {
      completed += group.length;
      if (typeof onProgress === 'function') onProgress({ completed, total });
    }
  }

  const removed = db.deleteMessages(succeededIds);
  removeLocalFiles(removed);

  // IMAP MOVE crée normalement de nouveaux UID dans INBOX. Une relève ciblée
  // rend donc la restauration visible sans attendre le prochain minuteur.
  for (const accountId of affectedAccounts) {
    const account = getAccount(accountId);
    const inbox = account?.folderMap?.inbox || 'INBOX';
    if (!account) continue;
    try { await syncRole(account, inbox, 'inbox', source); } catch {}
  }

  return {
    processed: removed.length,
    restored: removed.length,
    skipped: Math.max(0, requested.length - eligible.length),
    errors,
  };
}

async function emptyTrash({ source = 'manual', onProgress = null } = {}) {
  const messages = db.listMessagesByRole('trash');
  const total = messages.length;
  let completed = 0;
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
      const local = localByAccountFolder.get(`${account.id}\u0000${folder}`) || [];
      try {
        await imap.emptyFolder(account, folder);
        removedIds.push(...local.map(message => message.id));
        completed += local.length;
        db.clearSyncState(account.id, folder);
      } catch (error) {
        errors.push({ accountId: account.id, folder, error: error.message });
        completed += local.length;
      } finally {
        if (typeof onProgress === 'function') onProgress({ completed, total });
      }
    }
  }

  const removed = db.deleteMessages(removedIds);
  removeLocalFiles(removed);
  return { deleted: removed.length, errors, source };
}

async function cleanupExpiredSpamForAccount(account, { source = 'retention', silent = false } = {}) {
  if (maintenanceOperation) return { processed: 0, skipped: 'maintenance' };
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

async function syncCalendarSubscription(id, { announce = true } = {}) {
  const subscription = db.getCalendarSubscription(id);
  if (!subscription) throw new Error('Abonnement de calendrier introuvable');
  if (!subscription.enabled) return { subscription, skipped: true, reason: 'disabled' };
  // Le choix effectué dans LibraMail (couleur / compte associé) reste
  // prioritaire, même si le serveur répond 304 Not Modified.
  db.updateCalendarSubscriptionEventsPresentation(subscription.id, {
    accountId: subscription.accountId,
    color: subscription.color,
  });
  try {
    const remote = await calendarSubscriptions.fetchCalendar(subscription.url, {
      etag: subscription.etag,
      lastModified: subscription.lastModified,
    });
    if (remote.notModified) {
      const current = db.updateCalendarSubscriptionSync(subscription.id, {
        etag: remote.etag,
        lastModified: remote.lastModified,
        lastSyncAt: Date.now(),
        lastStatus: 'ok',
        lastError: '',
      });
      if (announce) broadcast('calendar.subscriptions.changed', { action: 'synced', id: subscription.id, notModified: true });
      return { subscription: current, notModified: true, created: 0, updated: 0, unchanged: 0, removed: 0, total: 0 };
    }
    let fileName = 'calendar.ics';
    try { fileName = decodeURIComponent(new URL(remote.url || subscription.url).pathname.split('/').filter(Boolean).pop() || 'calendar.ics'); } catch {}
    const parsed = calendarImport.parseCalendarImport({
      text: remote.text,
      fileName,
      accountId: subscription.accountId,
      color: subscription.color,
      locale: config.locale || 'fr',
      importNamespace: `sub-${subscription.id}`,
    });
    const result = db.syncCalendarSubscriptionEvents(subscription.id, parsed.events);
    let current = subscription;
    if (!subscription.name && parsed.calendarName) {
      current = db.saveCalendarSubscription({ ...subscription, name: parsed.calendarName }, subscription.id);
    }
    current = db.updateCalendarSubscriptionSync(subscription.id, {
      etag: remote.etag,
      lastModified: remote.lastModified,
      lastSyncAt: Date.now(),
      lastStatus: 'ok',
      lastError: '',
    });
    if (announce) {
      broadcast('calendar.changed', { action: 'subscription-synced', id: subscription.id, ...result });
      broadcast('calendar.subscriptions.changed', { action: 'synced', id: subscription.id, ...result });
    }
    return {
      ...result,
      subscription: current,
      format: parsed.format,
      calendarName: parsed.calendarName || '',
      recurringSeries: parsed.recurringSeries || 0,
      cancelled: parsed.cancelled || 0,
      truncated: Boolean(parsed.truncated),
    };
  } catch (error) {
    const current = db.updateCalendarSubscriptionSync(subscription.id, {
      lastSyncAt: Date.now(),
      lastStatus: 'error',
      lastError: error.message,
    });
    if (announce) broadcast('calendar.subscriptions.changed', { action: 'error', id: subscription.id, error: error.message });
    error.subscription = current;
    throw error;
  }
}

function calendarSubscriptionIsDue(subscription, now = Date.now()) {
  const refreshMinutes = Math.max(0, Number(subscription?.refreshMinutes) || 0);
  if (!refreshMinutes) return false;
  const lastSyncAt = Math.max(0, Number(subscription?.lastSyncAt) || 0);
  return !lastSyncAt || (now - lastSyncAt) >= refreshMinutes * 60 * 1000;
}

async function syncAllCalendarSubscriptions({ announce = false, dueOnly = false } = {}) {
  if (calendarSubscriptionSyncBusy || maintenanceOperation || shuttingDown) return [];
  calendarSubscriptionSyncBusy = true;
  const results = [];
  try {
    const now = Date.now();
    for (const subscription of db.listCalendarSubscriptions({ enabledOnly: true })) {
      if (dueOnly && !calendarSubscriptionIsDue(subscription, now)) continue;
      try { results.push(await syncCalendarSubscription(subscription.id, { announce })); }
      catch (error) { results.push({ id: subscription.id, subscription, error: error.message }); }
    }
    return results;
  } finally {
    calendarSubscriptionSyncBusy = false;
  }
}


function stopAccountRuntime() {
  cancelActiveSyncs();
  for (const timer of syncTimers.values()) clearInterval(timer);
  syncTimers.clear();
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = null;
  if (scheduledSendTimer) clearInterval(scheduledSendTimer);
  scheduledSendTimer = null;
  if (calendarSubscriptionTimer) clearInterval(calendarSubscriptionTimer);
  calendarSubscriptionTimer = null;
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
  if (scheduledSendTimer) clearInterval(scheduledSendTimer);
  scheduledSendTimer = setInterval(() => processScheduledMessages().catch(() => {}), OUTBOX_CHECK_MS);
  scheduledSendTimer.unref?.();
  setTimeout(() => processScheduledMessages().catch(() => {}), 1500).unref?.();
  if (calendarSubscriptionTimer) clearInterval(calendarSubscriptionTimer);
  calendarSubscriptionTimer = setInterval(() => syncAllCalendarSubscriptions({ announce: true, dueOnly: true }).catch(() => {}), CALENDAR_SUBSCRIPTION_CHECK_MS);
  calendarSubscriptionTimer.unref?.();
  setTimeout(() => syncAllCalendarSubscriptions({ announce: true, dueOnly: true }).catch(() => {}), 5000).unref?.();
}

function backupTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function ensureMaintenanceAvailable() {
  if (maintenanceOperation) throw new Error('Une opération de sauvegarde ou de restauration est déjà en cours');
  if (activeSyncs.size) {
    throw new Error('Une relève est en cours. Réessayez lorsqu’elle est terminée.');
  }
}

async function withMaintenance(kind, task) {
  ensureMaintenanceAvailable();
  maintenanceOperation = kind;
  stopAccountRuntime();
  if (activeCleanups.size) {
    await Promise.allSettled([...activeCleanups.values()]);
  }
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
    if (keepEngineLog && isRuntimeDataFile(name)) continue;
    fs.renameSync(path.join(sourceDir, name), path.join(targetDir, name));
  }
}

function clearDataContents(dataDir, { keepEngineLog = false } = {}) {
  if (!fs.existsSync(dataDir)) return;
  for (const name of fs.readdirSync(dataDir)) {
    if (keepEngineLog && isRuntimeDataFile(name)) continue;
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
      return !isRuntimeDataFile(relative) && !['index.db-wal', 'index.db-shm'].includes(relative);
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
outbox.init(db.db, DATA);
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
outbox.init(db.db, DATA);
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


async function checkLatestRelease() {
  const endpoint = 'https://api.github.com/repos/technifree/LibraMail/releases/latest';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    if (typeof fetch !== 'function') throw new Error('fetch indisponible dans ce runtime Node.js');
    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `LibraMail/${APP_VERSION}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub ${response.status}`);
    const payload = await response.json();
    const latest = String(payload.tag_name || payload.name || '').replace(/^v/i, '');
    return {
      current: APP_VERSION,
      latest,
      tagName: payload.tag_name || '',
      name: payload.name || '',
      url: payload.html_url || 'https://github.com/technifree/LibraMail/releases',
      publishedAt: payload.published_at || '',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function sendMailNow(accountId, mail) {
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
}

async function processScheduledMessages() {
  if (scheduledSendBusy || maintenanceOperation || shuttingDown) return;
  scheduledSendBusy = true;
  try {
    let item;
    while ((item = outbox.claimDue(Date.now()))) {
      try {
        const result = await sendMailNow(item.accountId, item.mail || {});
        outbox.remove(item.id, 'scheduled');
        broadcast('scheduled.sent', {
          id: item.id,
          accountId: item.accountId,
          subject: item.subject,
          ...result,
        });
      } catch (error) {
        outbox.markFailed(item.id, error.message);
        broadcast('scheduled.failed', {
          id: item.id,
          accountId: item.accountId,
          subject: item.subject,
          error: error.message,
        });
      }
      broadcast('outbox.updated', outbox.counts());
    }
  } finally {
    scheduledSendBusy = false;
  }
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
      logoData: normalizeLogoData(input.logoData),
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

    try {
      credentialStore.storePair(account.id, imapPassword, smtpPassword);
      account.credentials = { store: 'system', version: 1, imap: true, smtp: true };
    } catch (error) {
      throw new Error(`Stockage sécurisé des mots de passe impossible : ${error.message}`);
    }

    accounts.push(account);
    if (!config.defaultAccountId) {
      config.defaultAccountId = account.id;
      saveJson(CONFIG_FILE, config);
    }
    saveAccounts();
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
      logoData: normalizeLogoData(input.logoData),
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

    try {
      credentialStore.storePair(candidate.id, candidate.imap.pass, candidate.smtp.pass || candidate.imap.pass);
      candidate.credentials = { store: 'system', version: 1, imap: true, smtp: true };
    } catch (error) {
      throw new Error(`Stockage sécurisé des mots de passe impossible : ${error.message}`);
    }

    imap.stopWatch(current.id);
    const timer = syncTimers.get(current.id);
    if (timer) clearInterval(timer);
    syncTimers.delete(current.id);
    const index = accounts.findIndex(account => account.id === current.id);
    accounts[index] = candidate;
    saveAccounts();
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
    credentialStore.removePair(id);

    accounts = accounts.filter(item => item.id !== id);
    if (config.signatureProfiles?.[id]) {
      const signatureProfiles = { ...config.signatureProfiles };
      delete signatureProfiles[id];
      config.signatureProfiles = signatureProfiles;
    }
    if (config.defaultAccountId === id) config.defaultAccountId = accounts[0]?.id || null;
    saveAccounts();
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
    saveAccounts();
    scheduleAccount(account);
    return publicAccount(account);
  },

  'accounts.setSpamRetention': async ({ id, days }) => {
    const account = getAccount(id);
    if (!account) throw new Error('Compte introuvable');
    account.spamRetentionDays = Math.max(0, Math.min(3650, Math.round(Number(days) || 0)));
    saveAccounts();
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
  'messages.remote.allow': ({ id, urls }) => ({
    urls: db.allowMessageRemoteResources(id, urls),
  }),
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
      remoteAllowedUrls: db.getMessageRemotePermissions(message.id),
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
      attachments: (parsed.attachments || []).map((attachment, index) => {
        const calendarInvite = isCalendarAttachment(attachment);
        const calendarImportState = calendarInvite ? db.getCalendarMailImport(message.id, index) : null;
        return {
          index,
          filename: attachment.filename || (calendarInvite ? calendarAttachmentFilename(attachment, index) : `piece-jointe-${index + 1}`),
          contentType: attachment.contentType,
          size: attachment.size,
          calendarInvite,
          calendarImportedAt: calendarImportState?.importedAt || 0,
          calendarEventCount: calendarImportState?.eventCount || 0,
        };
      }),
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
    await setMessageSpamState(message, Boolean(isSpam), { persistSenderRule: Boolean(isSpam) });
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
  'messages.restore': async ({ id }) => {
    const messages = resolveTrashRestoreSelection([{ type: 'message', id }]);
    if (!messages.length) return { processed: 0, restored: 0, errors: [] };
    return restoreMessagesFromTrash(messages, { source: 'restore-conversation' });
  },
  'messages.batchRestore': async ({ items }) => {
    const messages = resolveTrashRestoreSelection(items);
    return restoreMessagesFromTrash(messages, { source: 'batch-restore-conversations' });
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
        await setMessageSpamState(message, Boolean(isSpam), { persistSenderRule: Boolean(isSpam) });
        processed++;
      } catch (error) {
        errors.push({ id: message.id, error: error.message });
      }
    }
    return { processed, skipped, errors, stats: spam.stats() };
  },

  'spam.rules.list': async () => ({
    rules: db.listSpamRules(),
    senders: db.listCollectedSenders({ limit: 300 }),
  }),
  'spam.rules.save': async input => {
    const rule = db.saveSpamRule(input || {});
    const changed = db.applySpamRuleToExistingMessages(rule);
    broadcast('spam.rules.updated', { rule, changed });
    return { rule, changed, rules: db.listSpamRules(), senders: db.listCollectedSenders({ limit: 300 }) };
  },
  'spam.rules.remove': async ({ id }) => {
    db.removeSpamRule(id);
    broadcast('spam.rules.updated', { id: Number(id) });
    return { rules: db.listSpamRules(), senders: db.listCollectedSenders({ limit: 300 }) };
  },
  'spam.rules.promoteSender': async ({ email, action = 'block', kind = 'email' } = {}) => {
    const value = String(kind) === 'domain' ? db.senderDomain(email) : email;
    const rule = db.saveSpamRule({ kind, value, action });
    const changed = db.applySpamRuleToExistingMessages(rule);
    broadcast('spam.rules.updated', { rule, changed });
    return { rule, changed, rules: db.listSpamRules(), senders: db.listCollectedSenders({ limit: 300 }) };
  },
  'icons.sender.resolveMany': async ({ emails } = {}) => resolveSenderIconsForEmails(emails),
  'spam.stats': async () => spam.stats(),
  'spam.empty': async () => {
    const messages = db.listSpamMessages();
    broadcast('folder.empty.started', { kind: 'spam', count: messages.length });
    try {
      const result = await moveMessagesToTrash(messages, {
        source: 'empty-spam',
        onProgress: progress => broadcast('folder.empty.progress', { kind: 'spam', ...progress }),
      });
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
      const result = await emptyTrash({
        source: 'empty-trash',
        onProgress: progress => broadcast('folder.empty.progress', { kind: 'trash', ...progress }),
      });
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

  // ---------- Planning / calendrier ----------
  'calendar.list': async params => db.listCalendarEvents(params || {}),
  'calendar.get': async ({ id }) => db.getCalendarEvent(id),
  'calendar.save': async ({ id = null, event } = {}) => {
    const saved = db.saveCalendarEvent(event || {}, id);
    broadcast('calendar.changed', { action: id ? 'updated' : 'created', id: saved.id });
    return saved;
  },
  'calendar.remove': async ({ id } = {}) => {
    const removed = db.removeCalendarEvent(id);
    if (removed) broadcast('calendar.changed', { action: 'removed', id: Number(id) });
    return { removed };
  },
  'calendar.import': async ({ text = '', fileName = '', accountId = '', color = '', locale = 'fr' } = {}) => {
    const parsed = calendarImport.parseCalendarImport({ text, fileName, accountId, color, locale });
    const result = db.importCalendarEvents(parsed.events);
    broadcast('calendar.changed', { action: 'imported', count: result.total });
    return {
      ...result,
      format: parsed.format,
      calendarName: parsed.calendarName || '',
      recurringSeries: parsed.recurringSeries || 0,
      cancelled: parsed.cancelled || 0,
      truncated: Boolean(parsed.truncated),
    };
  },
  'calendar.importAttachment': async ({ messageId, index } = {}) => {
    const message = db.getMessage(messageId);
    if (!message) throw new Error('Message introuvable');
    const parsedMessage = await simpleParser(fs.readFileSync(localMessagePath(message)));
    const attachmentIndex = Number(index);
    const attachment = (parsedMessage.attachments || [])[attachmentIndex];
    if (!attachment) throw new Error('Pièce jointe introuvable');
    if (!isCalendarAttachment(attachment)) throw new Error('Cette pièce jointe n’est pas un calendrier compatible');

    const text = Buffer.isBuffer(attachment.content)
      ? attachment.content.toString('utf8')
      : String(attachment.content || '');
    const fileName = calendarAttachmentFilename(attachment, attachmentIndex);
    const accountId = String(message.account_id || '');
    const parsed = calendarImport.parseCalendarImport({
      text, fileName, accountId, color: '', locale: config.locale || 'fr',
    });
    const result = db.importCalendarEvents(parsed.events);
    const importState = db.markCalendarMailImport(message.id, attachmentIndex, result.total);
    broadcast('calendar.changed', {
      action: 'mail-invite-imported',
      messageId: Number(message.id),
      count: result.total,
    });
    return {
      ...result,
      importedAt: importState?.importedAt || Date.now(),
      eventCount: importState?.eventCount || result.total,
      calendarName: parsed.calendarName || '',
      recurringSeries: parsed.recurringSeries || 0,
      truncated: Boolean(parsed.truncated),
    };
  },
  'calendar.subscriptions.list': async () => db.listCalendarSubscriptions(),
  'calendar.subscriptions.add': async ({ name = '', url = '', accountId = '', color = '', refreshMinutes = 30 } = {}) => {
    const normalizedUrl = calendarSubscriptions.normalizeSubscriptionUrl(url);
    const subscription = db.saveCalendarSubscription({
      name: String(name || '').trim() || calendarSubscriptions.displayNameFromUrl(normalizedUrl),
      url: normalizedUrl, accountId, color, refreshMinutes, enabled: true,
    });
    broadcast('calendar.subscriptions.changed', { action: 'created', id: subscription.id });
    try {
      return await syncCalendarSubscription(subscription.id, { announce: true });
    } catch (error) {
      return { subscription: db.getCalendarSubscription(subscription.id), error: error.message };
    }
  },
  'calendar.subscriptions.update': async ({ id, name = '', url = '', accountId = '', color = '', refreshMinutes = 30 } = {}) => {
    const current = db.getCalendarSubscription(id);
    if (!current) throw new Error('Abonnement de calendrier introuvable');
    const normalizedUrl = calendarSubscriptions.normalizeSubscriptionUrl(url);
    const urlChanged = normalizedUrl !== current.url;
    let subscription = db.saveCalendarSubscription({
      ...current,
      name: String(name || '').trim() || calendarSubscriptions.displayNameFromUrl(normalizedUrl),
      url: normalizedUrl,
      accountId,
      color,
      refreshMinutes,
      enabled: true,
    }, id);
    db.updateCalendarSubscriptionEventsPresentation(subscription.id, {
      accountId: subscription.accountId,
      color: subscription.color,
    });
    if (urlChanged) {
      subscription = db.updateCalendarSubscriptionSync(subscription.id, {
        etag: '', lastModified: '', lastStatus: '', lastError: '',
      });
    }
    broadcast('calendar.changed', { action: 'subscription-updated', id: subscription.id });
    broadcast('calendar.subscriptions.changed', { action: 'updated', id: subscription.id });
    if (!urlChanged) return { subscription, updated: true, synced: false };
    try {
      const result = await syncCalendarSubscription(subscription.id, { announce: true });
      return { ...result, updated: true, synced: true };
    } catch (error) {
      return { subscription: db.getCalendarSubscription(subscription.id), updated: true, synced: false, error: error.message };
    }
  },
  'calendar.subscriptions.sync': async ({ id } = {}) => syncCalendarSubscription(id, { announce: true }),
  'calendar.subscriptions.syncAll': async () => syncAllCalendarSubscriptions({ announce: true }),
  'calendar.subscriptions.remove': async ({ id } = {}) => {
    const result = db.removeCalendarSubscription(id);
    if (result.removed) {
      broadcast('calendar.changed', { action: 'subscription-removed', id: Number(id), removed: result.removedEvents });
      broadcast('calendar.subscriptions.changed', { action: 'removed', id: Number(id) });
    }
    return result;
  },

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

  // ---------- Brouillons et envois différés ----------
  'outbox.counts': async () => outbox.counts(),
  'outbox.list': async ({ kind }) => ({ items: outbox.list(kind), counts: outbox.counts() }),
  'outbox.get': async ({ id, kind }) => outbox.get(id, kind),
  'outbox.remove': async ({ id, kind }) => {
    const removed = outbox.remove(id, kind);
    const counts = outbox.counts();
    broadcast('outbox.updated', counts);
    return { removed, counts };
  },
  'drafts.save': async ({ id = null, state, removeScheduledId = null }) => {
    const item = outbox.saveDraft({ id, state, removeScheduledId });
    const counts = outbox.counts();
    broadcast('outbox.updated', counts);
    return { item, counts };
  },
  'scheduled.save': async ({ id = null, accountId, state, mail, sendAt, removeDraftId = null }) => {
    const item = outbox.saveScheduled({ id, accountId, state, mail, sendAt, removeDraftId });
    const counts = outbox.counts();
    broadcast('outbox.updated', counts);
    return { item, counts };
  },
  'scheduled.sendNow': async ({ id }) => {
    const item = outbox.claim(id);
    if (!item) throw new Error('Envoi différé introuvable ou déjà traité');
    try {
      const result = await sendMailNow(item.accountId, item.mail || {});
      outbox.remove(item.id, 'scheduled');
      const counts = outbox.counts();
      broadcast('scheduled.sent', { id: item.id, accountId: item.accountId, subject: item.subject, ...result });
      broadcast('outbox.updated', counts);
      return result;
    } catch (error) {
      outbox.markFailed(item.id, error.message);
      broadcast('scheduled.failed', { id: item.id, accountId: item.accountId, subject: item.subject, error: error.message });
      broadcast('outbox.updated', outbox.counts());
      throw error;
    }
  },
  'scheduled.retry': async ({ id, sendAt }) => {
    const item = outbox.retry(id, sendAt || Date.now() + 60000);
    broadcast('outbox.updated', outbox.counts());
    return item;
  },
  // ---------- Envoi ----------
  'mail.send': async ({ accountId, mail, draftId = null, scheduledId = null }) => {
    const result = await sendMailNow(accountId, mail);
    if (draftId) outbox.remove(draftId, 'draft');
    if (scheduledId) outbox.remove(scheduledId, 'scheduled');
    const counts = outbox.counts();
    broadcast('outbox.updated', counts);
    return result;
  },

  // ---------- Ouverture externe sécurisée ----------
  'app.openExternal': async ({ url }) => openExternalWithSystem(url),

  // ---------- Version ----------
  'app.checkLatestVersion': async () => checkLatestRelease(),

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

const launcherParentArgument = process.argv.find(argument => String(argument).startsWith('--libramail-parent-pid='));
const launcherParentPid = Number(launcherParentArgument?.split('=')[1] || process.env.LIBRAMAIL_PARENT_PID || 0);
if (Number.isInteger(launcherParentPid) && launcherParentPid > 0) {
  const parentWatch = setInterval(() => {
    try {
      process.kill(launcherParentPid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') {
        console.warn('[LibraMail] Lanceur Windows fermé : arrêt du moteur.');
        shutdown();
      }
    }
  }, 2000);
  parentWatch.unref?.();
}

process.on('unhandledRejection', error => {
  // ImapFlow rejette les commandes encore en attente lorsqu'une relève est
  // interrompue volontairement. Ces NoConnection sont attendus uniquement
  // pour les connexions que LibraMail vient explicitement de couper.
  if (imap.isExpectedCancellationError?.(error)) return;
  console.error('[LibraMail] Promesse non interceptée :', error);
});
process.on('uncaughtException', error => {
  if (imap.isExpectedCancellationError?.(error)) return;
  console.error('[LibraMail] Erreur non interceptée :', error);
});

startAccountRuntime({ resolveFolders: true });

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

