'use strict';

const fs = require('fs');
const path = require('path');
const atomicFile = require('./atomic_file');

const HISTORY_VERSION = 1;
const DEFAULT_LIMIT = 30;
const VALID_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const SUMMARY_FIELDS = [
  'transferred', 'plannable', 'skipped', 'errors', 'missing', 'unidentified',
  'sourceBytes', 'skippedBytes', 'transferredBytes', 'estimatedBytes',
  'markedDeleted', 'deletedFolders',
];

function cleanString(value, maxLength = 2048) {
  return String(value ?? '').replace(/[\r\n\0]/g, ' ').slice(0, maxLength);
}

function cleanInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER, nullable = true } = {}) {
  if (value == null || value === '') return nullable ? null : min;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) return nullable ? null : min;
  return numeric;
}

function sanitizePlan(plan = {}) {
  let folders = null;
  if (Array.isArray(plan.folders)) {
    folders = plan.folders.slice(0, 500).map(item => ({
      source: cleanString(item?.source),
      destination: cleanString(item?.destination || item?.source),
    })).filter(item => item.source && item.destination);
    if (!folders.length) folders = null;
  }
  const filters = plan.filters && typeof plan.filters === 'object' ? plan.filters : {};
  return {
    folders,
    filters: {
      since: /^\d{4}-\d{2}-\d{2}$/.test(String(filters.since || '')) ? String(filters.since) : null,
      until: /^\d{4}-\d{2}-\d{2}$/.test(String(filters.until || '')) ? String(filters.until) : null,
      minSize: cleanInteger(filters.minSize, { min: 1 }),
      maxSize: cleanInteger(filters.maxSize, { min: 1 }),
    },
  };
}

function sanitizeSummary(summary = {}) {
  const result = {};
  for (const field of SUMMARY_FIELDS) result[field] = cleanInteger(summary[field]);
  result.estimateBeforeSizeFilter = Boolean(summary.estimateBeforeSizeFilter);
  result.destinationConfirmed = Boolean(summary.destinationConfirmed);
  return result;
}

function sanitizeRecord(record = {}) {
  const status = VALID_STATUSES.has(String(record.status || '')) ? String(record.status) : 'failed';
  const startedAt = cleanInteger(record.startedAt, { min: 0, nullable: false });
  const finishedAt = cleanInteger(record.finishedAt, { min: startedAt, nullable: false });
  return {
    id: cleanString(record.id, 128),
    startedAt,
    finishedAt,
    status,
    sourceAccountId: cleanString(record.sourceAccountId, 256),
    destinationAccountId: cleanString(record.destinationAccountId, 256),
    mirror: record.mirror === true,
    plan: sanitizePlan(record.plan),
    summary: sanitizeSummary(record.summary),
    elapsedMs: cleanInteger(record.elapsedMs, { min: 0, nullable: false }),
    exitCode: cleanInteger(record.exitCode, { min: -1, max: 100000 }),
  };
}

class ImapMigrationHistoryStore {
  constructor({ dataDir, limit = DEFAULT_LIMIT } = {}) {
    if (!dataDir) throw new Error('Dossier de données manquant pour l’historique Migration IMAP.');
    this.file = path.join(path.resolve(dataDir), 'imap-migration-history.json');
    this.limit = Math.max(1, Math.min(200, Number(limit) || DEFAULT_LIMIT));
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
      return items.map(sanitizeRecord).filter(item => item.id && item.sourceAccountId && item.destinationAccountId)
        .slice(0, this.limit);
    } catch {
      return [];
    }
  }

  list() {
    return this._load();
  }

  add(record) {
    const item = sanitizeRecord(record);
    if (!item.id || !item.sourceAccountId || !item.destinationAccountId) {
      throw new Error('Historique Migration IMAP : entrée incomplète.');
    }
    const items = this._load().filter(existing => existing.id !== item.id);
    items.unshift(item);
    const payload = { version: HISTORY_VERSION, items: items.slice(0, this.limit) };
    atomicFile.writeJsonAtomicSync(this.file, payload, { mode: 0o600 });
    return item;
  }

  clear() {
    try { fs.rmSync(this.file, { force: true }); } catch {}
    return true;
  }
}

module.exports = {
  HISTORY_VERSION,
  DEFAULT_LIMIT,
  sanitizePlan,
  sanitizeSummary,
  sanitizeRecord,
  ImapMigrationHistoryStore,
};
