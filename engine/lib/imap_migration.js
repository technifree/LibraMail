'use strict';

/*
 * LibraMail - Migration IMAP
 *
 * Cette intégration reprend et adapte des principes de conception du projet libre
 * Mailbox Synchroniseur : https://github.com/Othman-Benbrahim/Mailbox-Synchroniseur
 * Projet d'origine sous licence MIT - Copyright (c) 2026 Mailbox Synchroniseur contributors.
 * Voir THIRD_PARTY_NOTICES.md pour la notice complète.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const MAX_LINE_LENGTH = 65536;
const PREVIEW_MAX_AGE_MS = 30 * 60 * 1000;

function accountDescriptor(account, label = 'compte') {
  if (!account || String(account.receiveProtocol || 'imap').toLowerCase() !== 'imap') {
    throw new Error(`${label} : un compte IMAP LibraMail est requis.`);
  }
  const imap = account.imap || {};
  const host = String(imap.host || '').trim();
  const user = String(imap.user || '').trim();
  const port = Number(imap.port) || (imap.secure === false ? 143 : 993);
  if (!host || /[\s/\\]/.test(host) || /^https?:/i.test(host)) {
    throw new Error(`${label} : serveur IMAP invalide.`);
  }
  if (!user || /[\r\n\0]/.test(user)) throw new Error(`${label} : identifiant IMAP invalide.`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} : port IMAP invalide.`);
  const password = String(imap.pass || '');
  if (!password || /[\r\n\0]/.test(password)) throw new Error(`${label} : mot de passe IMAP indisponible.`);
  return {
    id: String(account.id || ''),
    label: String(account.displayName || account.email || user || label),
    email: String(account.email || ''),
    host,
    user,
    port,
    secure: imap.secure !== false,
    password,
  };
}

function ensureDistinctAccounts(source, destination) {
  if (source.id && destination.id && source.id === destination.id) {
    throw new Error('La source et la destination doivent être deux comptes différents.');
  }
  const sameEndpoint = source.host.toLowerCase() === destination.host.toLowerCase()
    && source.port === destination.port
    && source.user.toLowerCase() === destination.user.toLowerCase();
  if (sameEndpoint) throw new Error('La source et la destination désignent le même compte IMAP.');
}

function tlsArgs(index, account) {
  const result = account.secure
    ? [`--ssl${index}`, `--notls${index}`]
    : [`--nossl${index}`, `--tls${index}`];
  for (const option of [
    'SSL_verify_mode=1',
    'SSL_verifycn_scheme=imap',
    `SSL_verifycn_name=${account.host}`,
  ]) result.push(`--sslargs${index}`, option);
  result.push(`--timeout${index}`, '30');
  return result;
}

const IMAP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ROLE_ALIASES = {
  sent: ['sent', 'sent items', 'sent messages', 'sent mail', 'envoyés', 'envoyes',
    'éléments envoyés', 'elements envoyes', 'messages envoyés', 'messages envoyes',
    '[gmail]/sent mail', '[google mail]/sent mail'],
  drafts: ['drafts', 'draft', 'brouillons', '[gmail]/drafts', '[google mail]/drafts'],
  trash: ['trash', 'deleted items', 'deleted messages', 'corbeille', 'éléments supprimés',
    'elements supprimes', 'bin', '[gmail]/trash', '[gmail]/bin', '[google mail]/trash'],
  junk: ['junk', 'junk e-mail', 'junk email', 'spam', 'pourriel', 'pourriels',
    'courrier indésirable', 'courrier indesirable', 'indésirables', 'indesirables',
    '[gmail]/spam', '[google mail]/spam'],
  archive: ['archive', 'archives', 'archived'],
};

function imapUtf7(name) {
  const input = String(name ?? '');
  const output = [];
  let pending = '';

  const flush = () => {
    if (!pending) return;
    const le = Buffer.from(pending, 'utf16le');
    const be = Buffer.allocUnsafe(le.length);
    for (let index = 0; index < le.length; index += 2) {
      be[index] = le[index + 1];
      be[index + 1] = le[index];
    }
    output.push(`&${be.toString('base64').replace(/\//g, ',').replace(/=+$/g, '')}-`);
    pending = '';
  };

  for (const char of input) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      output.push(char === '&' ? '&-' : char);
    } else {
      pending += char;
    }
  }
  flush();
  return output.join('');
}

function normalizeSpecialUse(value) {
  const normalized = String(value || '').trim().replace(/^\\/, '').toLowerCase();
  const aliases = {
    inbox: 'inbox',
    sent: 'sent',
    drafts: 'drafts',
    trash: 'trash',
    junk: 'junk',
    spam: 'junk',
    archive: 'archive',
    all: 'all',
    allmail: 'all',
  };
  return aliases[normalized] || '';
}

function normalizeFolder(folder = {}) {
  const pathValue = String(folder.path || folder.name || '').normalize('NFC');
  const flags = Array.isArray(folder.flags) ? folder.flags.map(flag => String(flag)) : [];
  const selectable = folder.selectable !== false
    && !flags.some(flag => String(flag).toLowerCase() === '\\noselect');
  return {
    path: pathValue,
    name: String(folder.name || pathValue).normalize('NFC'),
    delimiter: folder.delimiter == null ? null : String(folder.delimiter),
    specialUse: String(folder.specialUse || ''),
    role: normalizeSpecialUse(folder.specialUse),
    flags,
    selectable,
  };
}

function folderRole(folder) {
  const normalized = normalizeFolder(folder);
  if (normalized.role) return normalized.role;
  const lowered = normalized.path.toLocaleLowerCase('fr');
  for (const [role, aliases] of Object.entries(ROLE_ALIASES)) {
    if (aliases.some(alias => lowered === alias.toLocaleLowerCase('fr'))) return role;
  }
  if (lowered === 'inbox') return 'inbox';
  return '';
}

function translateDelimiter(name, sourceDelimiter, destinationDelimiter) {
  const source = String(sourceDelimiter || '');
  const destination = String(destinationDelimiter || '');
  if (!source || !destination || source === destination) return String(name || '');
  return String(name || '').split(source).join(destination);
}

function folderDepth(folder) {
  const delimiter = String(folder.delimiter || '');
  if (!delimiter) return 0;
  return String(folder.path || '').split(delimiter).length - 1;
}

function proposeFolderMappings(sourceFolders = [], destinationFolders = []) {
  const source = sourceFolders.map(normalizeFolder).filter(folder => folder.path);
  const destination = destinationFolders.map(normalizeFolder).filter(folder => folder.path);
  const byName = new Map(destination.map(folder => [folder.path, folder]));
  const byCase = new Map();
  for (const folder of destination) {
    const key = folder.path.toLocaleLowerCase('fr');
    if (!byCase.has(key)) byCase.set(key, folder);
  }
  const byRole = new Map();
  for (const folder of destination) {
    const role = folderRole(folder);
    if (role && folder.selectable && !byRole.has(role)) byRole.set(role, folder);
  }
  const destinationDelimiter = destination.find(folder => folder.delimiter)?.delimiter
    || source.find(folder => folder.delimiter)?.delimiter
    || '/';
  const used = new Set();
  const renamed = new Map();
  const results = [];

  const ordered = [...source].sort((a, b) => folderDepth(a) - folderDepth(b));

  const inheritedTarget = folder => {
    if (!folder.delimiter) return '';
    const parts = folder.path.split(folder.delimiter);
    for (let cut = parts.length - 1; cut > 0; cut--) {
      const prefix = parts.slice(0, cut).join(folder.delimiter);
      const targetPrefix = renamed.get(prefix);
      if (targetPrefix && targetPrefix !== prefix) {
        return `${targetPrefix}${destinationDelimiter}${parts.slice(cut).join(destinationDelimiter)}`;
      }
    }
    return '';
  };

  for (const folder of ordered) {
    if (!folder.selectable) {
      results.push({
        source: folder.path,
        destination: '',
        selected: false,
        locked: true,
        kind: 'excludedNoselect',
      });
      continue;
    }
    if (folderRole(folder) === 'all') {
      results.push({
        source: folder.path,
        destination: '',
        selected: false,
        locked: true,
        kind: 'excludedAll',
      });
      continue;
    }

    const role = folderRole(folder);
    let candidate = '';
    let kind = '';

    if (folder.path === 'INBOX' || byName.has(folder.path)) {
      candidate = folder.path;
      kind = 'identical';
    } else if (role && byRole.has(role)) {
      candidate = byRole.get(role).path;
      kind = 'role';
    } else if (byCase.has(folder.path.toLocaleLowerCase('fr'))) {
      candidate = byCase.get(folder.path.toLocaleLowerCase('fr')).path;
      kind = 'case';
    } else {
      const inherited = inheritedTarget(folder);
      if (inherited) {
        candidate = inherited;
        kind = 'parent';
      } else {
        candidate = translateDelimiter(folder.path, folder.delimiter, destinationDelimiter);
        kind = byName.has(candidate) ? 'delimiter' : 'new';
      }
    }

    const collisionKey = candidate.toLocaleLowerCase('fr');
    if (used.has(collisionKey)) {
      results.push({
        source: folder.path,
        destination: candidate,
        selected: false,
        locked: false,
        kind: 'collision',
      });
      continue;
    }

    used.add(collisionKey);
    renamed.set(folder.path, candidate);
    results.push({
      source: folder.path,
      destination: candidate,
      selected: true,
      locked: false,
      kind,
    });
  }

  return {
    sourceFolders: source,
    destinationFolders: destination,
    mappings: results,
    destinationDelimiter,
  };
}

function validFolderName(value, label) {
  const name = String(value ?? '').normalize('NFC');
  if (!name.trim() || name.startsWith('-') || /[\r\n\0]/.test(name)) {
    throw new Error(`${label} : nom de dossier invalide.`);
  }
  if (name.length > 2048) throw new Error(`${label} : nom de dossier trop long.`);
  return name;
}

function parseIsoDate(value, label) {
  if (value == null || value === '') return null;
  const text = String(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`${label} : date invalide (AAAA-MM-JJ attendu).`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${label} : date invalide.`);
  }
  return date;
}

function imapDate(date) {
  return `${date.getUTCDate()}-${IMAP_MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function normalizePositiveInteger(value, label) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0 || numeric > 2 ** 40) {
    throw new Error(`${label} : valeur invalide.`);
  }
  return numeric;
}

function normalizeMigrationPlan(plan = {}) {
  let folders = null;
  if (plan.folders != null) {
    if (!Array.isArray(plan.folders) || plan.folders.length === 0) {
      throw new Error('Sélectionnez au moins un dossier à copier.');
    }
    const sourceSeen = new Set();
    const destinationSeen = new Set();
    folders = plan.folders.map((mapping, index) => {
      const source = validFolderName(mapping?.source, `Dossier source ${index + 1}`);
      const destination = validFolderName(mapping?.destination || source, `Dossier destination ${index + 1}`);
      if (source.includes('=')) {
        throw new Error('Un nom de dossier source contenant « = » ne peut pas être utilisé dans une correspondance explicite.');
      }
      const sourceKey = source.toLocaleLowerCase('fr');
      const destinationKey = destination.toLocaleLowerCase('fr');
      if (sourceSeen.has(sourceKey)) throw new Error('Un dossier source est sélectionné plusieurs fois.');
      if (destinationSeen.has(destinationKey)) throw new Error('Deux dossiers source ne peuvent pas viser le même dossier destination.');
      sourceSeen.add(sourceKey);
      destinationSeen.add(destinationKey);
      return { source, destination };
    });
  }

  const filtersInput = plan.filters && typeof plan.filters === 'object' ? plan.filters : {};
  const sinceDate = parseIsoDate(filtersInput.since, 'Date de début');
  const untilDate = parseIsoDate(filtersInput.until, 'Date de fin');
  if (sinceDate && untilDate && sinceDate.getTime() > untilDate.getTime()) {
    throw new Error('La date de début doit précéder ou égaler la date de fin.');
  }
  const minSize = normalizePositiveInteger(filtersInput.minSize, 'Taille minimale');
  const maxSize = normalizePositiveInteger(filtersInput.maxSize, 'Taille maximale');
  if (minSize != null && maxSize != null && maxSize <= minSize) {
    throw new Error('La taille maximale doit être supérieure à la taille minimale.');
  }

  return {
    folders,
    filters: {
      since: sinceDate ? String(filtersInput.since) : null,
      until: untilDate ? String(filtersInput.until) : null,
      minSize,
      maxSize,
    },
  };
}

function searchCriteria(filters = {}) {
  const normalized = normalizeMigrationPlan({ filters }).filters;
  const parts = [];
  if (normalized.since) parts.push(`SINCE ${imapDate(parseIsoDate(normalized.since, 'Date de début'))}`);
  if (normalized.until) {
    const until = parseIsoDate(normalized.until, 'Date de fin');
    until.setUTCDate(until.getUTCDate() + 1);
    parts.push(`BEFORE ${imapDate(until)}`);
  }
  return parts.join(' ');
}

function buildCommandArgs(source, destination, mode = 'preview', plan = {}) {
  if (!['login', 'preview', 'copy'].includes(mode)) throw new Error('Mode de migration IMAP invalide.');
  ensureDistinctAccounts(source, destination);
  const normalizedPlan = normalizeMigrationPlan(plan);
  const args = [
    '--noreleasecheck',
    '--nolog',
    '--noexpunge1',
    '--nodelete1',
    '--noresyncflags',
    '--regexflag', 's/\\\\Deleted//g',
    '--noexpunge2',
    '--host1', source.host,
    '--user1', source.user,
    '--port1', String(source.port),
    ...tlsArgs(1, source),
    '--host2', destination.host,
    '--user2', destination.user,
    '--port2', String(destination.port),
    ...tlsArgs(2, destination),
  ];
  if (mode === 'login') {
    args.push('--justlogin');
    return args;
  }

  if (mode === 'preview') args.push('--dry');

  if (normalizedPlan.folders) {
    for (const mapping of normalizedPlan.folders) {
      const sourceFolder = imapUtf7(mapping.source);
      const destinationFolder = imapUtf7(mapping.destination || mapping.source);
      args.push('--folder', sourceFolder, '--f1f2', `${sourceFolder}=${destinationFolder}`);
    }
  }

  const criteria = searchCriteria(normalizedPlan.filters);
  if (criteria) args.push('--search', criteria);
  if (normalizedPlan.filters.maxSize != null) args.push('--maxsize', String(normalizedPlan.filters.maxSize));
  if (normalizedPlan.filters.minSize != null) args.push('--minsize', String(normalizedPlan.filters.minSize));
  return args;
}

function secretVariants(secret) {
  const raw = String(secret || '');
  if (!raw) return [];
  const values = new Set([raw]);
  try { values.add(encodeURIComponent(raw)); } catch {}
  try { values.add(Buffer.from(raw, 'utf8').toString('base64')); } catch {}
  return [...values].filter(Boolean).sort((a, b) => b.length - a.length);
}

function redactLine(line, secrets = []) {
  let value = String(line || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const secret of secrets.flatMap(secretVariants)) value = value.split(secret).join('[MASQUÉ]');
  value = value
    .replace(/\b(IMAPSYNC_PASSWORD[12])\s*=\s*\S+/gi, '$1=[MASQUÉ]')
    .replace(/\b(password\d?|passwd\d?|oauthaccesstoken\d?)\s*[:=]\s*\S+/gi, '$1=[MASQUÉ]');
  return [...value].filter(char => char === '\t' || char.charCodeAt(0) >= 32).join('');
}

function emptySummary() {
  return {
    transferred: null,
    plannable: null,
    skipped: null,
    errors: null,
    missing: null,
    unidentified: null,
    sourceBytes: null,
    skippedBytes: null,
    transferredBytes: null,
  };
}

function parseSummaryLine(summary, input) {
  const line = String(input || '').replace(/[\r\n]+$/, '');
  const labels = [
    ['Messages transferred', 'transferred'],
    ['Messages skipped', 'skipped'],
    ['Messages found in host1 not in host2', 'missing'],
    ['Total bytes transferred', 'transferredBytes'],
    ['Total bytes skipped', 'skippedBytes'],
    ['Host1 Total size', 'sourceBytes'],
  ];
  for (const [label, field] of labels) {
    const match = line.match(new RegExp(`^${label.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*:\\s*(\\d+)\\b`));
    if (match) summary[field] = Number(match[1]);
  }
  let match = line.match(/^Messages transferred\s*:\s*\d+\s*\(could be (\d+) without --dry mode\)/);
  if (match) summary.plannable = Number(match[1]);
  match = line.match(/^Detected (\d+) errors\b/);
  if (match) summary.errors = Number(match[1]);
  if (line.startsWith('There is no unidentified message on host1.')) summary.unidentified = 0;
  match = line.match(/^There are (\d+) unidentified messages/);
  if (match) summary.unidentified = Number(match[1]);
  return summary;
}

function estimatedBytes(summary) {
  if (summary.sourceBytes == null || summary.skippedBytes == null) return null;
  const value = Number(summary.sourceBytes) - Number(summary.skippedBytes);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function successfulCopySummary(summary) {
  if (Number(summary.errors || 0) > 0) return false;
  if (summary.missing != null && Number(summary.missing) > 0) return false;
  if (summary.unidentified != null && Number(summary.unidentified) > 0) return false;
  return true;
}

function exitMessage(code) {
  const messages = {
    0: 'Opération terminée sans erreur signalée par imapsync.',
    12: 'Connexion TLS refusée : vérifiez le certificat et le nom du serveur.',
    16: 'Authentification refusée : vérifiez les accès et les exigences du fournisseur.',
    161: 'Authentification refusée sur le compte source.',
    162: 'Authentification refusée sur le compte destination.',
    101: 'Impossible de joindre le serveur source.',
    102: 'Impossible de joindre le serveur destination.',
    113: 'Quota de la destination atteint ; la copie peut être partielle.',
    121: 'La recherche IMAP a échoué : vérifiez que les serveurs acceptent les filtres par dates ; la copie peut être partielle.',
  };
  return messages[Number(code)] || `imapsync a signalé une erreur (code ${Number(code)}).`;
}

function isExecutableFile(file, platform = process.platform) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    fs.accessSync(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name, env = process.env, platform = process.platform) {
  const pathValue = String(env.PATH || env.Path || '');
  if (!pathValue) return '';
  const suffixes = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${name}${suffix}`);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return '';
}

function resolveEngine(root, env = process.env, platform = process.platform) {
  const override = String(env.LIBRAMAIL_IMAPSYNC_PATH || '').trim();
  if (override) {
    const file = path.resolve(override);
    if (!isExecutableFile(file, platform)) throw new Error('Le moteur imapsync configuré est introuvable ou non exécutable.');
    return { path: file, source: 'override' };
  }
  const bundled = platform === 'win32'
    ? path.join(root, 'runtime', 'imapsync', 'imapsync.exe')
    : path.join(root, 'runtime', 'imapsync', 'imapsync');
  if (isExecutableFile(bundled, platform)) return { path: bundled, source: 'bundled' };
  const system = findOnPath('imapsync', env, platform);
  if (system) return { path: system, source: 'path' };
  throw new Error('Moteur imapsync non disponible. Il sera embarqué dans les paquets LibraMail lors de la phase de packaging.');
}

function processEnvironment(base, sourcePassword, destinationPassword) {
  const env = {};
  for (const [key, value] of Object.entries(base || {})) {
    if (!/^IMAPSYNC_/i.test(key)) env[key] = value;
  }
  env.IMAPSYNC_PASSWORD1 = sourcePassword;
  env.IMAPSYNC_PASSWORD2 = destinationPassword;
  return env;
}

class ImapMigrationManager {
  constructor({
    root,
    env = process.env,
    platform = process.platform,
    spawnImpl = spawn,
    engineResolver = null,
    onEvent = () => {},
    onRecord = () => {},
    now = () => Date.now(),
  } = {}) {
    if (!root) throw new Error('Racine LibraMail manquante pour la migration IMAP.');
    this.root = path.resolve(root);
    this.env = env;
    this.platform = platform;
    this.spawnImpl = spawnImpl;
    this.engineResolver = engineResolver || (() => resolveEngine(this.root, this.env, this.platform));
    this.onEvent = onEvent;
    this.onRecord = onRecord;
    this.now = now;
    this.fingerprintKey = crypto.randomBytes(32);
    this.active = null;
    this.preview = null;
  }

  invalidatePreview() {
    this.preview = null;
  }

  _recordCopy({ runId, source, destination, plan, startedAt, finishedAt, status, summary, elapsedMs, exitCode }) {
    if (!['completed', 'failed', 'cancelled'].includes(status)) return;
    try {
      this.onRecord({
        id: runId,
        startedAt: Number(startedAt) || 0,
        finishedAt: Number(finishedAt) || Number(startedAt) || 0,
        status,
        sourceAccountId: source.id,
        destinationAccountId: destination.id,
        plan: normalizeMigrationPlan(plan),
        summary: { ...summary },
        elapsedMs: Math.max(0, Number(elapsedMs) || 0),
        exitCode: Number.isInteger(exitCode) ? exitCode : -1,
      });
    } catch {}
  }

  _fingerprint(source, destination, plan = {}) {
    const payload = {
      source: { id: source.id, host: source.host, port: source.port, user: source.user, secure: source.secure },
      destination: { id: destination.id, host: destination.host, port: destination.port, user: destination.user, secure: destination.secure },
      plan: normalizeMigrationPlan(plan),
      secrets: [source.password, destination.password].map(secret =>
        crypto.createHmac('sha256', this.fingerprintKey).update(secret).digest('hex')),
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  status() {
    let engine = null;
    let error = '';
    try { engine = this.engineResolver(); } catch (caught) { error = caught.message; }
    const previewValid = Boolean(this.preview && (this.now() - this.preview.createdAt) <= PREVIEW_MAX_AGE_MS);
    if (!previewValid) this.preview = null;
    return {
      available: Boolean(engine),
      engine: engine ? path.basename(engine.path) : '',
      engineSource: engine?.source || '',
      error,
      running: Boolean(this.active),
      mode: this.active?.mode || '',
      sourceId: this.active?.sourceId || '',
      destinationId: this.active?.destinationId || '',
      previewValid,
      previewToken: previewValid ? this.preview.token : '',
      previewSourceId: previewValid ? this.preview.sourceId : '',
      previewDestinationId: previewValid ? this.preview.destinationId : '',
    };
  }

  async run({ mode, sourceAccount, destinationAccount, previewToken = '', plan = {} } = {}) {
    if (this.active) throw new Error('Une migration IMAP est déjà en cours.');
    if (!['login', 'preview', 'copy'].includes(mode)) throw new Error('Mode de migration IMAP invalide.');

    const source = accountDescriptor(sourceAccount, 'Source');
    const destination = accountDescriptor(destinationAccount, 'Destination');
    ensureDistinctAccounts(source, destination);
    const normalizedPlan = normalizeMigrationPlan(plan);
    const fingerprint = this._fingerprint(source, destination, normalizedPlan);

    if (mode === 'copy') {
      const preview = this.preview;
      if (!preview || preview.token !== String(previewToken || '') || preview.fingerprint !== fingerprint
          || (this.now() - preview.createdAt) > PREVIEW_MAX_AGE_MS) {
        this.preview = null;
        throw new Error('Une simulation réussie du même plan est obligatoire avant la copie.');
      }
      this.preview = null;
    }

    const engine = this.engineResolver();
    const args = buildCommandArgs(source, destination, mode, normalizedPlan);
    const runId = crypto.randomUUID();
    const summary = emptySummary();
    const startedAt = this.now();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-imapsync-'));
    try { fs.chmodSync(tempRoot, 0o700); } catch {}
    const env = processEnvironment(this.env, source.password, destination.password);
    const secrets = [source.password, destination.password];

    return new Promise((resolve, reject) => {
      let settled = false;
      let buffers = { stdout: '', stderr: '' };
      let discard = { stdout: false, stderr: false };
      let killTimer = null;
      let child;

      const emit = (event, data = {}) => {
        try { this.onEvent(event, { runId, mode, sourceId: source.id, destinationId: destination.id, ...data }); } catch {}
      };

      const cleanup = () => {
        if (killTimer) clearTimeout(killTimer);
        try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
        if (this.active?.runId === runId) this.active = null;
      };

      const finish = (ok, resultOrError) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (ok) resolve(resultOrError);
        else reject(resultOrError instanceof Error ? resultOrError : new Error(String(resultOrError || 'Migration IMAP interrompue')));
      };

      const emitLine = raw => {
        parseSummaryLine(summary, raw);
        const line = redactLine(raw, secrets).trimEnd();
        if (!line) return;
        emit('migration.imap.line', { line });
      };

      const consume = (channel, chunk, final = false) => {
        let text = buffers[channel] + String(chunk || '');
        buffers[channel] = '';
        const segments = text.split(/(?<=\n)|(?<=\r)(?!\n)/);
        for (let index = 0; index < segments.length; index++) {
          const segment = segments[index];
          const ended = /[\r\n]$/.test(segment);
          if (!ended && index === segments.length - 1 && !final) {
            if (!discard[channel]) {
              buffers[channel] = segment;
              if (buffers[channel].length > MAX_LINE_LENGTH) {
                buffers[channel] = '';
                discard[channel] = true;
                emit('migration.imap.line', { line: '[Ligne de journal trop longue omise]' });
              }
            }
            continue;
          }
          if (discard[channel]) {
            discard[channel] = false;
            continue;
          }
          emitLine(segment);
        }
        if (final && buffers[channel] && !discard[channel]) emitLine(buffers[channel]);
        if (final) buffers[channel] = '';
      };

      try {
        child = this.spawnImpl(engine.path, args, {
          cwd: tempRoot,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        });
      } catch (error) {
        finish(false, new Error(`Impossible de lancer imapsync : ${error.message}`));
        return;
      }

      this.active = {
        runId,
        mode,
        sourceId: source.id,
        destinationId: destination.id,
        child,
        cancelled: false,
      };
      emit('migration.imap.started', { startedAt, engine: path.basename(engine.path) });

      child.stdout?.setEncoding?.('utf8');
      child.stderr?.setEncoding?.('utf8');
      child.stdout?.on?.('data', chunk => consume('stdout', chunk));
      child.stderr?.on?.('data', chunk => consume('stderr', chunk));

      child.once?.('error', error => {
        const elapsedMs = Math.max(0, this.now() - startedAt);
        if (mode === 'copy') {
          this._recordCopy({
            runId, source, destination, plan: normalizedPlan, startedAt, finishedAt: this.now(),
            status: 'failed', summary, elapsedMs, exitCode: -1,
          });
        }
        emit('migration.imap.error', { error: `Impossible de lancer imapsync : ${error.message}` });
        finish(false, new Error(`Impossible de lancer imapsync : ${error.message}`));
      });

      child.once?.('close', code => {
        if (settled) return;
        consume('stdout', '', true);
        consume('stderr', '', true);
        const elapsedMs = Math.max(0, this.now() - startedAt);
        const cancelled = Boolean(this.active?.runId === runId && this.active.cancelled);
        const exitCode = Number.isInteger(code) ? code : -1;
        const hasSizeFilter = normalizedPlan.filters.minSize != null || normalizedPlan.filters.maxSize != null;
        const resultSummary = {
          ...summary,
          estimatedBytes: mode === 'preview' ? estimatedBytes(summary) : null,
          estimateBeforeSizeFilter: mode === 'preview' && hasSizeFilter,
          destinationConfirmed: mode === 'copy' && exitCode === 0 && successfulCopySummary(summary),
        };

        if (cancelled) {
          const message = 'Opération arrêtée. Une copie peut être partielle ; refaites une simulation avant de reprendre.';
          this.preview = null;
          if (mode === 'copy') {
            this._recordCopy({
              runId, source, destination, plan: normalizedPlan, startedAt, finishedAt: this.now(),
              status: 'cancelled', summary: resultSummary, elapsedMs, exitCode,
            });
          }
          emit('migration.imap.cancelled', { elapsedMs, summary: resultSummary, error: message });
          finish(false, new Error(message));
          return;
        }

        const countersFail = Number(summary.errors || 0) > 0
          || (mode === 'copy' && !successfulCopySummary(summary));
        if (exitCode !== 0 || countersFail) {
          const message = exitCode !== 0
            ? exitMessage(exitCode)
            : 'Le bilan signale des erreurs ou des messages non transférés. Consultez le journal.';
          this.preview = null;
          if (mode === 'copy') {
            this._recordCopy({
              runId, source, destination, plan: normalizedPlan, startedAt, finishedAt: this.now(),
              status: 'failed', summary: resultSummary, elapsedMs, exitCode,
            });
          }
          emit('migration.imap.error', { elapsedMs, exitCode, summary: resultSummary, error: message });
          finish(false, new Error(message));
          return;
        }

        let token = '';
        if (mode === 'preview') {
          token = crypto.randomUUID();
          this.preview = {
            token,
            fingerprint,
            createdAt: this.now(),
            sourceId: source.id,
            destinationId: destination.id,
          };
        }
        if (mode === 'copy') {
          this._recordCopy({
            runId, source, destination, plan: normalizedPlan, startedAt, finishedAt: this.now(),
            status: 'completed', summary: resultSummary, elapsedMs, exitCode,
          });
        }
        const result = {
          ok: true,
          mode,
          runId,
          elapsedMs,
          exitCode,
          summary: resultSummary,
          previewToken: token,
          message: mode === 'login'
            ? 'Les deux accès IMAP ont été acceptés par imapsync.'
            : mode === 'preview'
              ? 'Simulation terminée. Aucune modification n’a été effectuée.'
              : 'Copie terminée.',
        };
        emit('migration.imap.done', result);
        finish(true, result);
      });

      this.active.cancel = () => {
        if (!this.active || this.active.runId !== runId || this.active.cancelled) return false;
        this.active.cancelled = true;
        this.preview = null;
        emit('migration.imap.line', { line: 'Arrêt demandé ; les messages déjà copiés restent à destination.' });
        try { child.kill('SIGTERM'); } catch {}
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 3000);
        killTimer.unref?.();
        return true;
      };
    });
  }

  cancel() {
    if (!this.active?.cancel) return false;
    return this.active.cancel();
  }
}

module.exports = {
  MAX_LINE_LENGTH,
  PREVIEW_MAX_AGE_MS,
  accountDescriptor,
  imapUtf7,
  normalizeFolder,
  folderRole,
  proposeFolderMappings,
  normalizeMigrationPlan,
  searchCriteria,
  buildCommandArgs,
  emptySummary,
  parseSummaryLine,
  estimatedBytes,
  successfulCopySummary,
  redactLine,
  resolveEngine,
  processEnvironment,
  ImapMigrationManager,
};
