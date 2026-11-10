#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { directory, stageForward, safeFilename, cleanupPrepared } = require('../engine/lib/compose_attachments');

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-attachments-v064-'));
  try {
    const data = path.join(temp, 'profile', 'data');
    const dir = directory(data);
    assert.equal(dir, path.join(data, 'compose-attachments'));
    assert(fs.statSync(dir).isDirectory());

    const original = [
      { filename: 'rapport.pdf', content: Buffer.from('%PDF-1.7\nabc\0\xff', 'latin1') },
      { filename: 'photo.jpg', content: Buffer.from([0xff, 0xd8, 0x12, 0x00, 0xd9]) },
      { filename: '../secret.txt', content: Buffer.from('safe text') },
    ];
    const prepared = stageForward(data, original, [0, 1, 2]);
    assert.equal(prepared.length, 3);
    for (let i = 0; i < original.length; i++) {
      assert(fs.existsSync(prepared[i].path));
      assert(prepared[i].path.startsWith(dir + path.sep));
      assert.deepEqual(fs.readFileSync(prepared[i].path), original[i].content);
      assert.equal(prepared[i].managedCopy, true);
      assert.equal(prepared[i].size, original[i].content.length);
    }
    assert(!prepared[2].filename.includes('/'));
    assert.equal(safeFilename('../abc.txt', 0).includes('/'), false);
    const unrelated = path.join(temp, 'never-delete.txt');
    fs.writeFileSync(unrelated, 'keep');
    assert.equal(cleanupPrepared(data, [{ path: unrelated, managedCopy: true }]), 0);
    assert(fs.existsSync(unrelated));
    assert.equal(cleanupPrepared(data, [{ ...prepared[2] }]), 1);
    assert(!fs.existsSync(prepared[2].path));

    assert.throws(() => stageForward(data, original, [0, 0]), /Indice/);
    assert.throws(() => stageForward(data, original, [5]), /Indice/);
    assert.throws(() => stageForward(data, original, ['0']), /Indice/);
    assert.throws(() => stageForward(data, [{ filename: 'missing.bin' }], [0]), /Contenu/);
    assert.deepEqual(stageForward(data, original, []), []);

    const bad = [{ filename: 'ok.bin', content: Buffer.from([1]) }, { filename: 'bad.bin' }];
    const before = new Set(fs.readdirSync(dir));
    assert.throws(() => stageForward(data, bad, [0, 1]), /Contenu/);
    assert.deepEqual(new Set(fs.readdirSync(dir)), before, 'Un transfert partiellement extrait doit être annulé');

    // Vérification MIME réelle, hors ligne : pièce jointe reçue -> copie -> transfert.
    // mailparser et nodemailer sont les bibliothèques déjà utilisées par le moteur.
    const MailComposer = require('../engine/node_modules/nodemailer/lib/mail-composer');
    const { simpleParser } = require('../engine/node_modules/mailparser');
    const sourceMime = await new MailComposer({
      from: 'alice@example.net', to: 'bob@example.net', subject: 'Original', text: 'Bonjour',
      attachments: original.slice(0, 2).map(a => ({ filename: a.filename, content: a.content })),
    }).compile().build();
    const parsedOriginal = await simpleParser(sourceMime);
    assert.equal(parsedOriginal.attachments.length, 2);
    const forwardedFiles = stageForward(data, parsedOriginal.attachments, [0, 1]);
    const forwardedMime = await new MailComposer({
      from: 'bob@example.net', to: 'carol@example.net', subject: 'Tr: Original', text: 'Transfert',
      attachments: forwardedFiles.map(a => ({ filename: a.filename, path: a.path })),
    }).compile().build();
    const parsedForward = await simpleParser(forwardedMime);
    assert.equal(parsedForward.attachments.length, 2);
    assert.deepEqual(parsedForward.attachments[0].content, original[0].content);
    assert.deepEqual(parsedForward.attachments[1].content, original[1].content);
    assert.equal(parsedForward.subject, 'Tr: Original');

    // Qualification du vrai module SMTP via simulation du transport, sans serveur extérieur.
    const smtpSrc = fs.readFileSync(path.join(__dirname, '../engine/lib/smtp.js'), 'utf8');
    let smtpCount = 0;
    let captured = null;
    let closed = 0;
    const mockTransport = {
      async sendMail(message) { captured = message; return { messageId: 'test', accepted: ['bob@example.net'] }; },
      close() { closed++; },
    };
    const mailAuth = { smtpAuth: () => ({ user: 'fixture', pass: 'fixture' }) };
    const FakeMailComposer = class {
      constructor(message) { this.message = message; }
      compile() { return { build: async () => Buffer.from(JSON.stringify({ n: this.message.attachments.length })) }; }
    };
    const smtpModule = { exports: {} };
    const builtinRequire = require;
    const localRequire = name => {
      if (name === 'nodemailer') return { createTransport: () => { smtpCount++; return mockTransport; } };
      if (name === 'nodemailer/lib/mail-composer') return FakeMailComposer;
      if (name === './mail_auth') return mailAuth;
      return builtinRequire(name);
    };
    vm.runInNewContext('(function(require,module,exports){' + smtpSrc + '\n})', {})(localRequire, smtpModule, smtpModule.exports);
    const smtp = smtpModule.exports;
    const account = { email: 'alice@example.net', smtp: { host: 'smtp.example.net' } };
    const mail = {
      to: 'bob@example.net', subject: 'Transfert multi-PJ', text: 'Message de test', attachments: prepared.slice(0, 2),
    };
    await smtp.send(account, mail);
    assert.equal(smtpCount, 1);
    assert.equal(closed, 1);
    assert.equal(captured.attachments.length, 2);
    assert.deepEqual(captured.attachments.map(a => a.filename), prepared.slice(0, 2).map(a => a.filename));
    assert.deepEqual(fs.readFileSync(captured.attachments[0].path), original[0].content);
    assert.deepEqual(fs.readFileSync(captured.attachments[1].path), original[1].content);
    const beforeBadSend = smtpCount;
    await assert.rejects(
      smtp.send(account, { ...mail, attachments: [...prepared, { filename: 'missing.pdf', path: path.join(dir, 'absent.pdf') }] }),
      /ENOENT|Pièce jointe/,
    );
    assert.equal(smtpCount, beforeBadSend, 'Fichier manquant : aucun contact SMTP ne doit démarrer');

    const ui = fs.readFileSync(path.join(__dirname, '../resources/js/app.js'), 'utf8');
    const backend = fs.readFileSync(path.join(__dirname, '../engine/backend.js'), 'utf8');
    assert(ui.includes("rpc('attachments.compose.directory')"), 'Le dossier de rédaction doit venir du moteur');
    assert(!ui.includes('function composeAttachmentStorageDirectory()'), 'NL_PATH ne doit plus servir de dossier de données');
    assert(ui.includes("rpc('attachments.forward.prepare', { messageId, indexes })"));
    assert(ui.includes('async function waitForComposeAttachments()'), 'La préparation doit être attendue');
    assert(ui.includes('await waitForComposeAttachments();'), 'L’envoi doit attendre la copie des pièces jointes');
    assert(ui.includes('await composeAttachmentQueue;'));
    const outbox = fs.readFileSync(path.join(__dirname, '../resources/js/outbox.js'), 'utf8');
    assert(outbox.includes('await App.waitForComposeAttachments();'), 'Le brouillon doit attendre les fichiers préparés');
    assert(ui.includes('if (composeForwardAttachmentError) throw composeForwardAttachmentError;'));
    assert(ui.includes('if (composeAttachmentError) throw composeAttachmentError;'));
    assert(ui.includes('const files = Array.from(input.files || []);'));
    assert(ui.includes('data-remove-compose-attachment'), 'Suppression des PJ depuis le compositeur');
    assert(backend.includes("'attachments.compose.directory': async"));
    assert(backend.includes("'attachments.compose.cleanup': async"));
    assert(ui.includes("rpc('attachments.compose.cleanup', { attachments: prepared })"));
    assert(backend.includes("'attachments.forward.prepare': async"));
    assert(backend.includes('composeAttachments.cleanupPrepared(DATA, mail?.attachments)'));
    assert(backend.includes('composeAttachments.cleanupPrepared(DATA, state?.attachments)'));

    for (const lang of ['fr', 'en']) {
      const locales = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/locales', lang + '.json'), 'utf8'));
      for (const key of ['compose.forwardAttachmentsError', 'compose.attachStorageError', 'compose.removeAttachment']) {
        assert(locales[key], `Traduction ${lang} manquante pour ${key}`);
      }
    }

    console.log('[LibraMail] 0.6.4 : pièces jointes ajoutées/transférées, SMTP prévalidé et fichiers binaires : OK');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
