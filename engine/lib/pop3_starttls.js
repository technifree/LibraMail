'use strict';

const net = require('net');
const tls = require('tls');

function assertArgument(value, label) {
  const text = String(value == null ? '' : value);
  if (/\r|\n/.test(text)) throw new Error(`${label} POP3 invalide`);
  return text;
}

class StartTlsPop3Client {
  constructor(options = {}) {
    this.host = String(options.host || '');
    this.port = Number(options.port) || 110;
    this.user = String(options.user || '');
    this.password = String(options.password || '');
    this.servername = String(options.servername || this.host);
    this.timeout = Math.max(1000, Number(options.timeout) || 45000);
    this.streamReadTimeout = Math.max(this.timeout, Number(options.streamReadTimeout) || 180000);
    this.tlsOptions = { ...(options.tlsOptions || {}) };
    this.socket = null;
    this.socketHandlers = null;
    this.lineBuffer = Buffer.alloc(0);
    this.lineQueue = [];
    this.lineWaiters = [];
    this.fatalError = null;
    this.connected = false;
    this.connectPromise = null;
  }

  _fail(error, eventName = 'error') {
    if (!this.fatalError) {
      const next = error instanceof Error ? error : new Error(String(error || 'Connexion POP3 interrompue'));
      next.eventName = next.eventName || eventName;
      this.fatalError = next;
    }
    while (this.lineWaiters.length) {
      const waiter = this.lineWaiters.shift();
      clearTimeout(waiter.timer);
      waiter.reject(this.fatalError);
    }
  }

  _pushLine(line) {
    const waiter = this.lineWaiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(line);
      return;
    }
    this.lineQueue.push(line);
  }

  _onData(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.lineBuffer = this.lineBuffer.length ? Buffer.concat([this.lineBuffer, data]) : data;
    while (true) {
      const eol = this.lineBuffer.indexOf('\r\n');
      if (eol < 0) break;
      const line = this.lineBuffer.subarray(0, eol);
      this.lineBuffer = this.lineBuffer.subarray(eol + 2);
      this._pushLine(line);
    }
  }

  _attachSocket(socket) {
    const handlers = {
      data: chunk => this._onData(chunk),
      error: error => this._fail(error, 'error'),
      end: () => this._fail(new Error('Connexion POP3 fermée par le serveur'), 'end'),
      close: () => {
        if (this.lineWaiters.length) this._fail(new Error('Connexion POP3 fermée par le serveur'), 'close');
      },
      timeout: () => {
        const error = new Error('Délai d’attente POP3 dépassé');
        error.eventName = 'timeout';
        this._fail(error, 'timeout');
        try { socket.destroy(error); } catch {}
      },
    };
    this.socket = socket;
    this.socketHandlers = handlers;
    socket.on('data', handlers.data);
    socket.on('error', handlers.error);
    socket.on('end', handlers.end);
    socket.on('close', handlers.close);
    socket.on('timeout', handlers.timeout);
    socket.setTimeout(this.timeout);
  }

  _detachSocket(socket = this.socket) {
    if (!socket || !this.socketHandlers) return;
    const handlers = this.socketHandlers;
    socket.removeListener('data', handlers.data);
    socket.removeListener('error', handlers.error);
    socket.removeListener('end', handlers.end);
    socket.removeListener('close', handlers.close);
    socket.removeListener('timeout', handlers.timeout);
    this.socketHandlers = null;
  }

  _readLine(timeoutMs = this.timeout) {
    if (this.lineQueue.length) return Promise.resolve(this.lineQueue.shift());
    if (this.fatalError) return Promise.reject(this.fatalError);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.lineWaiters.indexOf(waiter);
        if (index >= 0) this.lineWaiters.splice(index, 1);
        const error = new Error('Délai d’attente POP3 dépassé');
        error.eventName = 'timeout';
        reject(error);
      }, timeoutMs);
      this.lineWaiters.push(waiter);
    });
  }

  _writeCommand(parts) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) {
      const error = new Error('Connexion POP3 indisponible');
      error.eventName = 'no-socket';
      throw error;
    }
    const line = parts
      .map((part, index) => assertArgument(part, index === 0 ? 'Commande' : 'Argument'))
      .join(' ');
    this.socket.write(`${line}\r\n`);
  }

  async _command(parts, { multiline = false, timeoutMs = this.timeout } = {}) {
    this._writeCommand(parts);
    const statusLine = await this._readLine(timeoutMs);
    const status = statusLine.toString('utf8');
    if (!status.startsWith('+OK')) {
      const message = status.startsWith('-ERR') ? status.slice(4).trim() : status.trim();
      const error = new Error(message || `Commande POP3 ${parts[0]} refusée`);
      error.command = String(parts[0] || '');
      throw error;
    }
    const info = status.slice(3).trim();
    if (!multiline) return { info, payload: null };

    const lines = [];
    while (true) {
      let line = await this._readLine(timeoutMs);
      if (line.length === 1 && line[0] === 0x2e) break;
      if (line.length >= 2 && line[0] === 0x2e && line[1] === 0x2e) line = line.subarray(1);
      lines.push(line, Buffer.from('\r\n'));
    }
    return { info, payload: Buffer.concat(lines) };
  }

  async _openPlainSocket() {
    const socket = net.connect({ host: this.host, port: this.port });
    this._attachSocket(socket);
    await new Promise((resolve, reject) => {
      const onConnect = () => { cleanup(); resolve(); };
      const onError = error => { cleanup(); reject(error); };
      const cleanup = () => {
        socket.removeListener('connect', onConnect);
        socket.removeListener('error', onError);
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
    const greeting = (await this._readLine(this.timeout)).toString('utf8');
    if (!greeting.startsWith('+OK')) {
      throw new Error(greeting.replace(/^-ERR\s*/i, '') || 'Accueil POP3 invalide');
    }
  }

  async _supportsStartTls() {
    try {
      const response = await this._command(['CAPA'], { multiline: true });
      const capabilities = response.payload
        .toString('utf8')
        .split(/\r\n/)
        .map(line => line.trim().toUpperCase());
      return capabilities.some(line => line === 'STLS' || line.startsWith('STLS '));
    } catch (error) {
      if (error?.eventName) throw error;
      // CAPA est optionnel. Si le serveur le refuse proprement, on tente STLS
      // directement, qui reste obligatoire avant toute authentification.
      return null;
    }
  }

  async _upgradeToTls() {
    const raw = this.socket;
    if (!raw) throw new Error('Connexion POP3 indisponible avant STARTTLS');
    if (this.lineQueue.length || this.lineBuffer.length) {
      throw new Error('Données POP3 inattendues avant la négociation STARTTLS');
    }

    this._detachSocket(raw);
    raw.setTimeout(0);
    const tlsSocket = tls.connect({
      socket: raw,
      ...this.tlsOptions,
      servername: this.servername,
      rejectUnauthorized: true,
    });
    await new Promise((resolve, reject) => {
      const onSecure = () => { cleanup(); resolve(); };
      const onError = error => { cleanup(); reject(error); };
      const cleanup = () => {
        tlsSocket.removeListener('secureConnect', onSecure);
        tlsSocket.removeListener('error', onError);
      };
      tlsSocket.once('secureConnect', onSecure);
      tlsSocket.once('error', onError);
    });
    this.fatalError = null;
    this._attachSocket(tlsSocket);
  }

  async connect() {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      try {
        await this._openPlainSocket();
        const supportsStartTls = await this._supportsStartTls();
        if (supportsStartTls === false) {
          throw new Error('Le serveur POP3 n’annonce pas la capacité STARTTLS (STLS)');
        }
        await this._command(['STLS']);
        await this._upgradeToTls();
        await this._command(['USER', this.user]);
        await this._command(['PASS', this.password]);
        this.connected = true;
      } catch (error) {
        try { this.socket?.destroy(); } catch {}
        throw error;
      }
    })();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async UIDL() {
    await this.connect();
    const response = await this._command(['UIDL'], { multiline: true });
    return response.payload
      .toString('utf8')
      .split(/\r\n/)
      .filter(Boolean)
      .map(line => {
        const [number, ...uidParts] = line.trim().split(/\s+/);
        return [number, uidParts.join(' ')];
      });
  }

  async RETR(number) {
    await this.connect();
    const messageNumber = Number(number);
    if (!Number.isInteger(messageNumber) || messageNumber <= 0) {
      throw new Error('Numéro de message POP3 invalide');
    }
    const response = await this._command(
      ['RETR', messageNumber],
      { multiline: true, timeoutMs: this.streamReadTimeout },
    );
    return response.payload;
  }

  async command(name, ...args) {
    await this.connect();
    const command = String(name || '').trim().toUpperCase();
    if (!/^[A-Z]+$/.test(command)) throw new Error('Commande POP3 invalide');
    const response = await this._command([command, ...args]);
    return [response.info];
  }

  async QUIT() {
    if (!this.socket || this.socket.destroyed) return '';
    try {
      if (this.connected) {
        const response = await this._command(['QUIT']);
        return response.info;
      }
      return '';
    } finally {
      this.connected = false;
      this._detachSocket();
      try { this.socket?.end(); } catch {}
      try { this.socket?.destroy(); } catch {}
      this.socket = null;
    }
  }
}

module.exports = StartTlsPop3Client;
