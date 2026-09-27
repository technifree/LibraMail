'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'engine/lib/imap.js'), 'utf8');

assert(src.includes('const IMAP_FETCH_BATCH_SIZE = 200;'), 'taille des lots IMAP absente');
assert(src.includes('for (let batchFirstUid = firstUid; batchFirstUid <= lastUid; batchFirstUid += IMAP_FETCH_BATCH_SIZE)'),
  'boucle de récupération par lots absente');
assert(src.includes('const batchLastUid = Math.min(lastUid, batchFirstUid + IMAP_FETCH_BATCH_SIZE - 1);'),
  'borne de lot IMAP absente');
assert(src.includes('client.fetch(`${batchFirstUid}:${batchLastUid}`'),
  'FETCH IMAP ne travaille pas par lot');
assert(src.includes('maxUid = Math.max(maxUid, batchLastUid);'),
  'checkpoint de fin de lot absent');
assert(src.includes('[LibraMail][IMAP][MIME]'), 'diagnostic UID/MIME absent');
assert(src.includes('const folderRetryCounts = new Map();'), 'compteur de reconnexion par dossier absent');
assert(src.includes('isTransientImapError(error)'), 'détection des erreurs IMAP transitoires absente');
assert(src.includes('index -= 1;'), 'reprise du dossier après reconnexion absente');
assert(src.includes("return { connectMs: 20000, folderMs: 600000, totalMs: 900000 };"),
  'budget manuel grosse boîte absent');
assert(src.includes('degraded: degradedMessages'), 'compteur de messages MIME dégradés absent');

// Garde-fou : on ne doit pas avaler une erreur de stockage/indexation.
// Le try/catch dégradé doit entourer uniquement simpleParser().
const parserCatchStart = src.indexOf('let parsed;\n      let mimeDegraded = false;');
const storeIndex = src.indexOf('const { id } = db.upsertMessage(row);', parserCatchStart);
const catchIndex = src.indexOf('} catch (error) {', parserCatchStart);
assert(parserCatchStart >= 0 && catchIndex > parserCatchStart && storeIndex > catchIndex,
  'la tolérance MIME ne doit pas masquer les erreurs de stockage');

console.log('[LibraMail] Test lots/reprise IMAP 0.6.0 : OK');
