"use strict";

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const security = require(path.join(ROOT, 'engine/lib/rpc_security'));
const { WebSocket, WebSocketServer } = require(path.join(ROOT, 'engine/node_modules/ws'));

const backend = fs.readFileSync(path.join(ROOT, 'engine/backend.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'resources/js/app.js'), 'utf8');
const neutralino = JSON.parse(fs.readFileSync(path.join(ROOT, 'neutralino.config.json'), 'utf8'));

function openSocket(url, protocol, options = {}) {
  return new Promise(resolve => {
    let settled = false;
    const socket = protocol ? new WebSocket(url, protocol, options) : new WebSocket(url, options);
    const done = result => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch {}
      resolve(result);
    };
    socket.once('open', () => done({ opened: true }));
    socket.once('error', error => done({ opened: false, error }));
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      done({ opened: false, statusCode: response.statusCode });
    });
    setTimeout(() => done({ opened: false, timeout: true }), 1500).unref?.();
  });
}

(async () => {
  const token = security.createSessionToken();
  const otherToken = security.createSessionToken();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notStrictEqual(token, otherToken);
  assert.strictEqual(security.protocolForToken(token), `libramail-rpc-v1.${token}`);

  assert.strictEqual(security.isAllowedOrigin('https://example.org'), false);
  assert.strictEqual(security.isAllowedOrigin('http://localhost:1234'), true);
  assert.strictEqual(security.isAllowedOrigin('http://127.0.0.1:1234'), true);
  assert.strictEqual(security.isAllowedOrigin('null'), true);
  assert.strictEqual(security.isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.strictEqual(security.isLoopbackAddress('192.168.1.5'), false);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-rpc-test-'));
  try {
    const authFile = security.publishSessionFile(temp, { token, port: 47800, pid: process.pid });
    const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    assert.strictEqual(auth.token, token);
    assert.strictEqual(auth.port, 47800);
    assert.ok(!authFile.includes(path.join(temp, 'data') + path.sep));
    if (process.platform !== 'win32') {
      const mode = fs.statSync(authFile).mode & 0o777;
      assert.strictEqual(mode, 0o600);
    }

    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      maxPayload: security.MAX_PAYLOAD_BYTES,
      verifyClient: info => security.isClientAllowed(info, token),
    });
    await new Promise((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    const port = wss.address().port;
    const url = `ws://127.0.0.1:${port}`;

    const withoutToken = await openSocket(url, null, { origin: 'http://127.0.0.1:9999' });
    assert.strictEqual(withoutToken.opened, false, 'connexion sans token acceptée');

    const wrongToken = await openSocket(url, security.protocolForToken(otherToken), { origin: 'http://localhost:9999' });
    assert.strictEqual(wrongToken.opened, false, 'connexion avec mauvais token acceptée');

    const evilOrigin = await openSocket(url, security.protocolForToken(token), { origin: 'https://evil.example' });
    assert.strictEqual(evilOrigin.opened, false, 'Origin Web externe accepté');

    const allowed = await openSocket(url, security.protocolForToken(token), { origin: 'http://127.0.0.1:9999' });
    assert.strictEqual(allowed.opened, true, 'connexion LibraMail authentifiée refusée');

    await new Promise(resolve => wss.close(resolve));
    assert.strictEqual(security.removeSessionFile(temp, otherToken), false, 'un autre token a supprimé la session');
    assert.ok(fs.existsSync(authFile));
    assert.strictEqual(security.removeSessionFile(temp, token), true);
    assert.ok(!fs.existsSync(authFile));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  assert(backend.includes("require('./lib/rpc_security')"));
  assert(backend.includes('maxPayload: rpcSecurity.MAX_PAYLOAD_BYTES'));
  assert(backend.includes('verifyClient: info => rpcSecurity.isClientAllowed(info, RPC_SESSION_TOKEN)'));
  assert(backend.includes('publishSessionFile(STATE_ROOT'));
  assert(backend.includes('removeSessionFile(STATE_ROOT'));
  assert(app.includes("const RPC_PROTOCOL_PREFIX = 'libramail-rpc-v1.'"));
  assert(app.includes('Neutralino.os.getEnv(\'LIBRAMAIL_STATE_ROOT\')'));
  assert(app.includes('new WebSocket(ENGINE, rpcWebSocketProtocol())'));
  assert(!app.includes('ws.send(JSON.stringify({ id, method, params, token'));
  assert(neutralino.nativeAllowList.includes('os.getEnv'));

  console.log('[LibraMail] Test sécurité RPC WebSocket locale 0.5.0 : OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
