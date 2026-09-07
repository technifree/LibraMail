'use strict';

const fs = require('fs');
const assert = require('assert');

const smtp = fs.readFileSync('engine/lib/smtp.js', 'utf8');

assert(smtp.includes("const fs = require('fs');"));
assert(smtp.includes('function attachmentMetrics(attachments)'));
assert(smtp.includes('function smtpDiagnostic(account, mail, error, elapsedMs)'));
assert(smtp.includes('function closeTransport(transport)'));

const sendStart = smtp.indexOf('async function send(account, mail)');
const verifyStart = smtp.indexOf('async function verify(account)', sendStart);
const exportsStart = smtp.indexOf('module.exports', verifyStart);
assert(sendStart >= 0 && verifyStart > sendStart && exportsStart > verifyStart);

const sendBlock = smtp.slice(sendStart, verifyStart);
const verifyBlock = smtp.slice(verifyStart, exportsStart);

assert(sendBlock.includes('try {'));
assert(sendBlock.includes('catch (error)'));
assert(sendBlock.includes('finally {'));
assert(sendBlock.includes('closeTransport(transport);'));
assert(sendBlock.includes('smtpDiagnostic(account, mail, error'));
assert(sendBlock.includes('throw error;'));
assert.strictEqual((sendBlock.match(/sendMail\(/g) || []).length, 1);

assert(verifyBlock.includes('try {'));
assert(verifyBlock.includes('finally {'));
assert(verifyBlock.includes('closeTransport(transport);'));

const diagnosticStart = smtp.indexOf('function smtpDiagnostic');
const diagnosticEnd = smtp.indexOf('function closeTransport', diagnosticStart);
const diagnostic = smtp.slice(diagnosticStart, diagnosticEnd);
assert(!diagnostic.includes('.pass'));
assert(!diagnostic.includes('subject='));
assert(!diagnostic.includes('to='));
assert(!diagnostic.includes('filename='));

console.log('[LibraMail] Test nettoyage transport SMTP 0.5.0 : OK');
