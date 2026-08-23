'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'engine/lib/imap.js'),
  'utf8'
);

assert(src.includes('// LibraMail 0.4.4 — garde-fou des connexions IDLE persistantes'));
assert(src.includes("client.on('error', handleUnexpectedDisconnect);"));
assert(src.includes("client.on('close', () => handleUnexpectedDisconnect(null));"));
assert(src.includes("'ETIMEDOUT'"));
assert(src.includes('scheduleWatchRetry(account, onExists, error);'));
assert(src.includes('watchStoppingClients.add(client);'));
assert(src.includes('closeClientGracefully(client).catch(() => {'));

console.log('[LibraMail] Tests garde-fou IMAP IDLE : OK');
