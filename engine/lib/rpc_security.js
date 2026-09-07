"use strict";

// LibraMail 0.5.0 - protection RPC WebSocket local.
// Le serveur reste strictement lié à 127.0.0.1, mais une page Web ne doit pas
// pouvoir invoquer l'API locale simplement parce que LibraMail est ouvert.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROTOCOL_PREFIX = 'libramail-rpc-v1.';
const TOKEN_BYTES = 32;
const TOKEN_HEX_LENGTH = TOKEN_BYTES * 2;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const RUNTIME_DIRECTORY = '.runtime';
const AUTH_FILENAME = 'rpc-auth.json';

function createSessionToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

function validToken(value) {
  return new RegExp(`^[a-f0-9]{${TOKEN_HEX_LENGTH}}$`, 'i').test(String(value || ''));
}

function protocolForToken(token) {
  const normalized = String(token || '').toLowerCase();
  if (!validToken(normalized)) throw new Error('Jeton RPC local invalide');
  return `${PROTOCOL_PREFIX}${normalized}`;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requestedProtocols(request) {
  return String(request?.headers?.['sec-websocket-protocol'] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function hasValidProtocol(request, expectedToken) {
  let expected;
  try { expected = protocolForToken(expectedToken); }
  catch { return false; }
  return requestedProtocols(request).some(protocol => safeEqual(protocol, expected));
}

function normalizeRemoteAddress(value) {
  let address = String(value || '').trim().toLowerCase();
  if (address.startsWith('::ffff:')) address = address.slice(7);
  return address;
}

function isLoopbackAddress(value) {
  const address = normalizeRemoteAddress(value);
  return address === '127.0.0.1' || address === '::1';
}

function isAllowedOrigin(value) {
  const origin = String(value || '').trim();
  // Les clients non navigateur n'envoient pas toujours Origin. Le token reste
  // obligatoire dans tous les cas. "null" couvre notamment un contexte file://.
  if (!origin || origin === 'null') return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'file:') return true;
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const hostname = String(parsed.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function isClientAllowed(info, expectedToken) {
  const request = info?.req;
  if (!request) return false;
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
  const origin = info?.origin ?? request.headers?.origin ?? '';
  if (!isAllowedOrigin(origin)) return false;
  return hasValidProtocol(request, expectedToken);
}

function runtimeDirectory(stateRoot) {
  return path.join(path.resolve(String(stateRoot || '.')), RUNTIME_DIRECTORY);
}

function authFilePath(stateRoot) {
  return path.join(runtimeDirectory(stateRoot), AUTH_FILENAME);
}

function publishSessionFile(stateRoot, { token, port, pid = process.pid } = {}) {
  if (!validToken(token)) throw new Error('Jeton RPC local invalide');
  const directory = runtimeDirectory(stateRoot);
  const target = authFilePath(stateRoot);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  const payload = JSON.stringify({
    version: 1,
    protocol: PROTOCOL_PREFIX.slice(0, -1),
    token: String(token).toLowerCase(),
    port: Number(port) || 0,
    pid: Number(pid) || process.pid,
    startedAt: Date.now(),
  });
  fs.writeFileSync(target, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch {}
  return target;
}

function removeSessionFile(stateRoot, token) {
  const target = authFilePath(stateRoot);
  try {
    const current = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (token && !safeEqual(String(current?.token || ''), String(token || ''))) return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    return false;
  }
  try { fs.rmSync(target, { force: true }); } catch { return false; }
  try { fs.rmdirSync(runtimeDirectory(stateRoot)); } catch {}
  return true;
}

module.exports = {
  AUTH_FILENAME,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_PREFIX,
  RUNTIME_DIRECTORY,
  authFilePath,
  createSessionToken,
  hasValidProtocol,
  isAllowedOrigin,
  isClientAllowed,
  isLoopbackAddress,
  protocolForToken,
  publishSessionFile,
  removeSessionFile,
  safeEqual,
  validToken,
};
