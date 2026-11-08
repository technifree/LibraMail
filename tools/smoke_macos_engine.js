#!/usr/bin/env node
'use strict';
// Run with the Node binary bundled INSIDE the extracted LibraMail.app.
// Uses disposable data only; it never requires an IMAP/SMTP account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const [app, version, expectedArch] = process.argv.slice(2);
if (!app || !/^\d+\.\d+\.\d+$/.test(version || '') || !['arm64', 'x86_64'].includes(expectedArch)) {
  console.error('Usage: node smoke_macos_engine.js <LibraMail.app> <version> <x86_64|arm64>');
  process.exit(2);
}
const appRoot = path.join(path.resolve(app), 'Contents', 'Resources', 'app');
const node = path.join(appRoot, 'runtime', 'node', 'bin', 'node');
const backend = path.join(appRoot, 'engine', 'backend.js');
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-smoke-state-'));
const authPath = path.join(stateRoot, '.runtime', 'rpc-auth.json');
let child = null;
let socket = null;
let logs = '';

function checkPortAvailable() {
  return new Promise((resolve, reject) => {
    const probe = net.connect({ host: '127.0.0.1', port: 47800 });
    probe.setTimeout(1000);
    probe.once('connect', () => { probe.destroy(); reject(new Error('Port 47800 déjà occupé ; smoke-test non isolé')); });
    probe.once('error', error => {
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
    probe.once('timeout', () => { probe.destroy(); reject(new Error('Contrôle du port RPC expiré')); });
  });
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitFor(condition, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    if (child && child.exitCode !== null) throw new Error(`Moteur arrêté (${child.exitCode}) avant ${label}: ${logs.slice(-2500)}`);
    await sleep(100);
  }
  throw new Error(`Délai dépassé : ${label}. Journal: ${logs.slice(-2500)}`);
}
function connectRpc(WebSocket, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:47800', `libramail-rpc-v1.${token}`, {
      handshakeTimeout: 5000, origin: 'null',
    });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Connexion RPC expirée')); }, 6000);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', error => { clearTimeout(timer); reject(error); });
  });
}
function rpc(ws, method) {
  return new Promise((resolve, reject) => {
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error(`RPC ${method}: timeout`)); }, 6000);
    function onMessage(payload) {
      let response;
      try { response = JSON.parse(String(payload)); } catch { return; }
      if (response.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      if (response.ok) resolve(response.result);
      else reject(new Error(`RPC ${method}: ${response.error}`));
    }
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params: {} }), error => {
      if (error) { clearTimeout(timer); ws.off('message', onMessage); reject(error); }
    });
  });
}

async function main() {
  assert.equal(process.platform, 'darwin', 'Doit s’exécuter sur macOS');
  assert.equal(process.arch, expectedArch === 'x86_64' ? 'x64' : 'arm64', 'Architecture Node incorrecte');
  assert.equal(fs.readFileSync(path.join(appRoot, 'runtime', 'node', 'VERSION'), 'utf8').trim(),
    process.version.replace(/^v/, ''), 'Node embarqué incorrect');
  assert.equal(fs.existsSync(backend), true, 'Backend absent de l’application');
  assert.ok(fs.readFileSync(backend, 'utf8').includes(`APP_VERSION = '${version}'`), 'Version backend incohérente');
  const Database = require(path.join(appRoot, 'engine', 'node_modules', 'better-sqlite3'));
  const dbPath = path.join(stateRoot, 'smoke.sqlite');
  const db = new Database(dbPath);
  try {
    db.exec('CREATE TABLE smoke_test (message TEXT NOT NULL)');
    db.prepare('INSERT INTO smoke_test(message) VALUES (?)').run('LibraMail');
    assert.equal(db.prepare('SELECT message FROM smoke_test').get().message, 'LibraMail');
  } finally { db.close(); }
  console.log('[SMOKE] SQLite natif avec écriture/lecture dans le répertoire temporaire: OK');
  await checkPortAvailable();
  const WebSocket = require(path.join(appRoot, 'engine', 'node_modules', 'ws'));
  child = spawn(node, [backend], {
    cwd: appRoot,
    env: { ...process.env, HOME: stateRoot, LIBRAMAIL_STATE_ROOT: stateRoot,
      LIBRAMAIL_GOOGLE_CALENDAR_MOCK: '0', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { logs = (logs + String(chunk)).slice(-12000); });
  child.stderr.on('data', chunk => { logs = (logs + String(chunk)).slice(-12000); });
  await waitFor(() => fs.existsSync(authPath), 20000, 'session RPC locale');
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  assert.match(auth.token, /^[a-f0-9]{64}$/);
  assert.equal(auth.port, 47800);
  assert.equal(auth.pid, child.pid);
  socket = await connectRpc(WebSocket, auth.token);
  const status = await rpc(socket, 'security.status');
  assert.equal(typeof status.runtimeReady, 'boolean');
  console.log('[SMOKE] Moteur démarré et RPC sécurisé authentifié: OK');
  await rpc(socket, 'app.shutdown');
  socket.close(); socket = null;
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 8000, 'arrêt du moteur');
  assert.equal(fs.existsSync(authPath), false, 'Session RPC encore publiée après arrêt');
  assert.equal(fs.existsSync(path.join(appRoot, 'data')), false, 'Données écrites dans le paquet .app');
  console.log('[SMOKE] Arrêt propre et isolation des données: OK');
}
main().catch(error => { console.error('[SMOKE] ÉCHEC:', error.stack || error.message); process.exitCode = 1; })
  .finally(async () => {
    if (socket) { try { socket.terminate(); } catch {} }
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM'); } catch {}
      await sleep(500);
      if (child.exitCode === null && child.signalCode === null) try { child.kill('SIGKILL'); } catch {}
    }
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
