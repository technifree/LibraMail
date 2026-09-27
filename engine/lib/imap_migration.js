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

function buildCommandArgs(source, destination, mode = 'preview') {
  if (!['login', 'preview', 'copy'].includes(mode)) throw new Error('Mode de migration IMAP invalide.');
  ensureDistinctAccounts(source, destination);
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
  if (mode === 'login') args.push('--justlogin');
  else if (mode === 'preview') args.push('--dry');
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
    121: 'La recherche IMAP a échoué ; la copie peut être partielle.',
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
    now = () => Date.now(),
  } = {}) {
    if (!root) throw new Error('Racine LibraMail manquante pour la migration IMAP.');
    this.root = path.resolve(root);
    this.env = env;
    this.platform = platform;
    this.spawnImpl = spawnImpl;
    this.engineResolver = engineResolver || (() => resolveEngine(this.root, this.env, this.platform));
    this.onEvent = onEvent;
    this.now = now;
    this.fingerprintKey = crypto.randomBytes(32);
    this.active = null;
    this.preview = null;
  }

  invalidatePreview() {
    this.preview = null;
  }

  _fingerprint(source, destination) {
    const payload = {
      source: { id: source.id, host: source.host, port: source.port, user: source.user, secure: source.secure },
      destination: { id: destination.id, host: destination.host, port: destination.port, user: destination.user, secure: destination.secure },
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

  async run({ mode, sourceAccount, destinationAccount, previewToken = '' } = {}) {
    if (this.active) throw new Error('Une migration IMAP est déjà en cours.');
    if (!['login', 'preview', 'copy'].includes(mode)) throw new Error('Mode de migration IMAP invalide.');

    const source = accountDescriptor(sourceAccount, 'Source');
    const destination = accountDescriptor(destinationAccount, 'Destination');
    ensureDistinctAccounts(source, destination);
    const fingerprint = this._fingerprint(source, destination);

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
    const args = buildCommandArgs(source, destination, mode);
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
        emit('migration.imap.error', { error: `Impossible de lancer imapsync : ${error.message}` });
        finish(false, new Error(`Impossible de lancer imapsync : ${error.message}`));
      });

      child.once?.('close', code => {
        consume('stdout', '', true);
        consume('stderr', '', true);
        const elapsedMs = Math.max(0, this.now() - startedAt);
        const cancelled = Boolean(this.active?.runId === runId && this.active.cancelled);
        const exitCode = Number.isInteger(code) ? code : -1;
        const resultSummary = {
          ...summary,
          estimatedBytes: mode === 'preview' ? estimatedBytes(summary) : null,
          destinationConfirmed: mode === 'copy' && exitCode === 0 && successfulCopySummary(summary),
        };

        if (cancelled) {
          const message = 'Opération arrêtée. Une copie peut être partielle ; refaites une simulation avant de reprendre.';
          this.preview = null;
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
