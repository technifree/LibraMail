'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const backend = fs.readFileSync(path.join(root, 'engine/backend.js'), 'utf8');
const mailStore = fs.readFileSync(path.join(root, 'engine/lib/mail_store.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'resources/js/app.js'), 'utf8');

assert(backend.includes("// LibraMail 0.4.8 — démarrage verrouillable par mot de passe principal."));
assert(backend.includes("const masterPassword = require('./lib/master_password');"));
assert(backend.includes('masterPassword.init(DATA);'));

const runtimeStart = backend.indexOf('function initializeRuntimeState()');
assert(runtimeStart >= 0);
const runtimeBlock = backend.slice(runtimeStart, runtimeStart + 1200);
assert(runtimeBlock.includes("if (masterPassword.isLocked()) throw new Error('LibraMail est verrouillé');"));
assert(runtimeBlock.includes('recoverInterruptedRestore();'));
assert(runtimeBlock.includes('db.init(DATA);'));
assert(runtimeBlock.includes('mailStore.init(DATA);'));
assert(runtimeBlock.includes('outbox.init(db.db, DATA);'));
assert(runtimeBlock.includes('loadRuntimeState();'));

assert(backend.includes("if (!masterPassword.isLocked()) initializeRuntimeState();"));
assert(backend.includes('async function ensureStartupStorageMigration()'));
assert(backend.includes("console.log('[LibraMail] Mot de passe principal requis avant chargement des données.');"));

assert(backend.includes("'security.status': async () => {"));
assert(backend.includes("'security.unlock': async ({ password = '' } = {}) => {"));
assert(backend.includes("'security.lock': async () => {"));
assert(backend.includes("'security.status',\n        'security.unlock',\n        'app.shutdown',"));
assert(backend.includes("throw new Error('LibraMail est verrouillé');"));

const lockRuntime = backend.indexOf('function closeRuntimeStateForLock()');
assert(lockRuntime >= 0);
const lockBlock = backend.slice(lockRuntime, lockRuntime + 700);
assert(lockBlock.includes('stopAccountRuntime();'));
assert(lockBlock.includes('mailStore.close();'));
assert(lockBlock.includes('db.close();'));
assert(lockBlock.includes('accounts = [];'));
assert(lockBlock.includes('runtimeInitialized = false;'));

assert(mailStore.includes('function clearMasterKeys()'));
assert(mailStore.includes('masterKey.fill(0)'));
assert(mailStore.includes('masterSearchKey.fill(0)'));
const closePos = mailStore.indexOf('function close()');
assert(closePos >= 0);
assert(mailStore.slice(closePos, closePos + 400).includes('clearMasterKeys();'));

const bootPos = app.indexOf('async function boot()');
assert(bootPos >= 0);
const boot = app.slice(bootPos, bootPos + 650);
const securityPos = boot.indexOf("rpc('security.status')");
const configPos = boot.indexOf("rpc('config.get')");
assert(securityPos >= 0 && configPos > securityPos);
assert(boot.includes('if (security?.locked)'));
assert(boot.includes("t('security.lockedTitle')"));
assert(boot.includes('showSecurityLockScreen();'));
assert(boot.includes('hideStartupScreen();'));

console.log('[LibraMail] Tests runtime verrouillable 0.4.8 : OK');
