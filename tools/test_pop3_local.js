'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const credentialStore = require('../engine/lib/credential_store');
const secrets = new Map();
credentialStore.readServiceSecret = name => secrets.get(String(name)) || '';
credentialStore.writeServiceSecret = (name, value) => { secrets.set(String(name), String(value)); return true; };
credentialStore.removeServiceSecret = name => secrets.delete(String(name));

const db = require('../engine/lib/db');
const mailStore = require('../engine/lib/mail_store');
const pop3 = require('../engine/lib/pop3');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-pop3-test-'));
(async () => {
  try {
    db.init(temp);
    mailStore.init(temp);
    const account = {
      id: 'pop-account-test', email: 'vince@example.test',
      pop3: { host: 'pop.example.test', port: 995, secure: true, user: 'vince@example.test', pass: 'secret', deletePolicy: 'keep' },
    };
    const raw = Buffer.from([
      'From: Service <service@example.test>',
      'To: Vince <vince@example.test>',
      'Subject: Message POP3 local',
      'Message-ID: <pop-test@example.test>',
      'Date: Sat, 15 Aug 2026 12:30:00 +0200',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Le téléchargement POP3 est conservé localement.',
    ].join('\r\n'));
    const stored = await pop3.storeRawMessage(account, raw);
    const message = db.getMessage(stored.id);
    assert(message, 'message POP3 absent de l’index');
    assert.strictEqual(message.folder_role, 'inbox');
    assert.strictEqual(message.storage_kind, 'encrypted');
    assert(mailStore.readMessage(message).equals(raw), 'source POP3 chiffrée différente de l’original');
    console.log('[LibraMail] Test stockage POP3 local : OK');
  } finally {
    try { mailStore.close(); } catch {}
    try { db.close(); } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
