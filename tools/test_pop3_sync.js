'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const calls = { retr: [], dele: [], quit: 0 };
const raws = new Map([
  [1, 'From: a@example.test\r\nTo: v@example.test\r\nSubject: A\r\nMessage-ID: <A@test>\r\n\r\nMessage A'],
  [2, 'From: b@example.test\r\nTo: v@example.test\r\nSubject: B\r\nMessage-ID: <B@test>\r\n\r\nMessage B'],
]);
class FakePop3 {
  async UIDL() { return [['1', 'uid-a'], ['2', 'uid-b']]; }
  async RETR(number) { calls.retr.push(Number(number)); return raws.get(Number(number)); }
  async command(name, arg) {
    if (String(name).toUpperCase() === 'DELE') calls.dele.push(Number(arg));
    return ['OK'];
  }
  async QUIT() { calls.quit++; return 'OK'; }
}
const credentialStore = require('../engine/lib/credential_store');
const secrets = new Map();
credentialStore.readServiceSecret = name => secrets.get(String(name)) || '';
credentialStore.writeServiceSecret = (name, value) => { secrets.set(String(name), String(value)); return true; };
credentialStore.removeServiceSecret = name => secrets.delete(String(name));

const db = require('../engine/lib/db');
const mailStore = require('../engine/lib/mail_store');
const pop3 = require('../engine/lib/pop3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-pop-sync-test-'));

(async () => {
  try {
    db.init(temp);
    mailStore.init(temp);
    const account = {
      id: 'pop-sync', email: 'v@example.test',
      pop3: { host: 'pop.example.test', port: 995, secure: true, user: 'v@example.test', pass: 'pw', deletePolicy: 'keep', deleteAfterDays: 7 },
    };
    const options = { clientFactory: () => new FakePop3() };
    const first = await pop3.syncAccount(account, temp, null, options);
    assert.strictEqual(first.added, 2);
    assert.deepStrictEqual(calls.retr, [1, 2]);
    assert.strictEqual(db.getPop3State(account.id).length, 2);

    const second = await pop3.syncAccount(account, temp, null, options);
    assert.strictEqual(second.added, 0, 'UIDL doit empêcher les doublons');
    assert.deepStrictEqual(calls.retr, [1, 2], 'aucun RETR supplémentaire attendu');

    account.pop3.deletePolicy = 'immediate';
    const third = await pop3.syncAccount(account, temp, null, options);
    assert.strictEqual(third.added, 0);
    assert.strictEqual(third.deletedFromServer, 2);
    assert.deepStrictEqual(calls.dele.slice(-2), [1, 2]);
    assert(db.getPop3State(account.id).every(row => Number(row.server_deleted_at) > 0));
    assert.strictEqual(db.countMessages({ accountId: account.id }).n, 2, 'la suppression serveur ne doit pas supprimer la copie locale');
    console.log('[LibraMail] Test synchronisation POP3/UIDL : OK');
  } finally {
    try { mailStore.close(); } catch {}
    try { db.close(); } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
