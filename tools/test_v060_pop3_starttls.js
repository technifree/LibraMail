'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const StartTlsPop3Client = require('../engine/lib/pop3_starttls');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const html = read('resources/index.html');
const app = read('resources/js/app.js');
const backend = read('engine/backend.js');
const pop3 = read('engine/lib/pop3.js');
const fr = JSON.parse(read('resources/locales/fr.json'));
const en = JSON.parse(read('resources/locales/en.json'));

assert(html.includes('id="acc-pop3-secure"'), 'sélecteur de sécurité POP3 absent');
assert(!/id="acc-pop3-secure"[^>]*disabled/.test(html), 'sélecteur POP3 encore désactivé');
assert(/id="acc-pop3-secure"[\s\S]*?value="1"[\s\S]*?value="0"/.test(html), 'options SSL/TLS et STARTTLS absentes');
assert(app.includes("accountField('acc-pop3-secure').value = '1';"), 'valeur POP3 par défaut absente');
assert(app.includes("details.pop3?.secure === false ? '0' : '1'"), 'édition POP3 ne restaure pas STARTTLS');
assert(app.includes("secure: accountField('acc-pop3-secure').value === '1'"), 'enregistrement POP3 ne transmet pas le choix de sécurité');
assert(!backend.includes("POP3 doit utiliser SSL/TLS dans LibraMail"), 'backend refuse encore STARTTLS');
assert(pop3.includes("return new StartTlsPop3Client(common);"), 'moteur POP3 ne route pas STARTTLS vers le client STLS');
assert(fr['account.popLocalHint'].includes('STARTTLS') && fr['account.popLocalHint'].includes('110'));
assert(en['account.popLocalHint'].includes('STARTTLS') && en['account.popLocalHint'].includes('110'));

(async () => {
  class OrderedClient extends StartTlsPop3Client {
    constructor(supports = true) {
      super({ host: 'pop.example.test', port: 110, user: 'user', password: 'secret' });
      this.steps = [];
      this.supports = supports;
      this.socket = { destroy() {} };
    }
    async _openPlainSocket() { this.steps.push('TCP'); }
    async _supportsStartTls() { this.steps.push('CAPA'); return this.supports; }
    async _command(parts) { this.steps.push(String(parts[0])); return { info: '', payload: Buffer.alloc(0) }; }
    async _upgradeToTls() { this.steps.push('TLS'); }
  }

  const client = new OrderedClient(true);
  await client.connect();
  assert.deepStrictEqual(
    client.steps,
    ['TCP', 'CAPA', 'STLS', 'TLS', 'USER', 'PASS'],
    'USER/PASS doivent impérativement être envoyés après STLS et la négociation TLS',
  );
  assert.strictEqual(client.connected, true);

  const rejected = new OrderedClient(false);
  await assert.rejects(() => rejected.connect(), /STARTTLS \(STLS\)/);
  assert(!rejected.steps.includes('USER') && !rejected.steps.includes('PASS'), 'identifiants envoyés malgré absence de STLS');

  const injectionGuard = new StartTlsPop3Client({ host: 'example.test' });
  let written = '';
  injectionGuard.socket = {
    destroyed: false,
    writable: true,
    write(value) { written += value; },
  };
  assert.throws(() => injectionGuard._writeCommand(['USER', 'ok\r\nPASS bad']), /invalide/);
  assert.strictEqual(written, '', 'commande injectée écrite sur le socket');

  const multiline = new StartTlsPop3Client({ host: 'example.test' });
  written = '';
  multiline.socket = {
    destroyed: false,
    writable: true,
    write(value) { written += value; },
  };
  multiline._pushLine(Buffer.from('+OK list follows'));
  multiline._pushLine(Buffer.from('1 uid-1'));
  multiline._pushLine(Buffer.from('2 uid-2'));
  multiline._pushLine(Buffer.from('.'));
  const response = await multiline._command(['UIDL'], { multiline: true });
  assert.strictEqual(written, 'UIDL\r\n');
  assert.strictEqual(response.payload.toString('utf8'), '1 uid-1\r\n2 uid-2\r\n');

  console.log('[LibraMail] Test POP3 STARTTLS 0.6.0 : OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
