/**
 * LibraMail — Envoi SMTP (nodemailer)
 * Le message est envoyé avec le serveur du compte sélectionné. Une copie MIME
 * identique est renvoyée au moteur afin qu'il puisse l'ajouter dans le dossier
 * « Envoyés » du même compte via IMAP.
 */
'use strict';
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');

function transporter(account) {
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port || 465,
    secure: account.smtp.secure !== false,
    auth: {
      user: account.smtp.user || account.pop3?.user || account.imap?.user,
      pass: account.smtp.pass || account.pop3?.pass || account.imap?.pass,
    },
  });
}

function normalizeAttachments(attachments) {
  return (attachments || []).map(attachment => attachment.path
    ? { filename: attachment.filename, path: attachment.path }
    : {
        filename: attachment.filename,
        content: Buffer.from(attachment.content || '', 'base64'),
      });
}

function createMessage(account, mail) {
  const domain = String(account.email || '').split('@')[1] || 'libramail.local';
  const messageId = mail.messageId || `<${crypto.randomUUID()}@${domain}>`;
  const receiptAddress = String(account.email || account.smtp?.user || account.pop3?.user || account.imap?.user || '').trim();
  const headers = {};

  // MDN : le destinataire reste libre d'accepter ou de refuser l'envoi
  // de l'accusé de lecture. Le second en-tête améliore la compatibilité
  // avec certains clients historiques.
  if (mail.readReceipt && receiptAddress) {
    headers['Disposition-Notification-To'] = receiptAddress;
    headers['X-Confirm-Reading-To'] = receiptAddress;
  }

  return {
    from: { name: account.displayName || '', address: account.email },
    to: mail.to,
    cc: mail.cc || undefined,
    bcc: mail.bcc || undefined,
    subject: mail.subject,
    text: mail.text || undefined,
    html: mail.html || undefined,
    inReplyTo: mail.inReplyTo || undefined,
    references: mail.references || undefined,
    attachments: normalizeAttachments(mail.attachments),
    headers: Object.keys(headers).length ? headers : undefined,
    dsn: mail.deliveryReceipt && receiptAddress ? {
      id: crypto.randomUUID(),
      return: 'headers',
      notify: ['success', 'failure', 'delay'],
      recipient: receiptAddress,
    } : undefined,
    messageId,
    date: new Date(),
  };
}

async function send(account, mail) {
  const message = createMessage(account, mail);
  const transport = transporter(account);
  const info = await transport.sendMail(message);

  // La copie du dossier Envoyés ne doit pas exposer l'en-tête Bcc à d'autres
  // destinataires. Elle reste néanmoins une copie complète du contenu envoyé.
  const sentCopy = { ...message, bcc: undefined, dsn: undefined };
  const raw = await new MailComposer(sentCopy).compile().build();

  return {
    messageId: info.messageId || message.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    raw,
  };
}

async function verify(account) {
  return transporter(account).verify();
}

module.exports = { send, verify };
