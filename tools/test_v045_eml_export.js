'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'resources', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'resources', 'js', 'app.js'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'engine', 'backend.js'), 'utf8');
const fr = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'locales', 'fr.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'locales', 'en.json'), 'utf8'));

assert(index.includes('id="btn-export-eml"'));
assert(app.includes('// LibraMail 0.4.5 — export du message brut au format EML.'));
assert(app.includes("Neutralino.os.showSaveDialog(t('emlExport.title')"));
assert(app.includes("rpc('messages.exportEml'"));
assert(app.includes("document.getElementById('btn-export-eml').onclick = exportCurrentMessageEml"));

const marker = '// LibraMail 0.4.5 — export EML sans reconstruction du message.';
assert(backend.includes(marker));
const start = backend.indexOf(marker);
const end = backend.indexOf("'messages.read': async", start);
assert(start >= 0 && end > start);
const exportBlock = backend.slice(start, end);

assert(exportBlock.includes('const raw = readLocalMessage(message);'));
assert(exportBlock.includes('fs.writeFileSync(resolvedTarget, raw);'));
assert(!exportBlock.includes('simpleParser('));

assert.strictEqual(fr['action.exportEml'], 'Exporter .eml');
assert.strictEqual(en['action.exportEml'], 'Export .eml');

const sample = Buffer.from([
  0x46,0x72,0x6f,0x6d,0x3a,0x20,0x61,0x40,0x62,0x0d,0x0a,
  0x53,0x75,0x62,0x6a,0x65,0x63,0x74,0x3a,0x20,0x54,0x65,0x73,0x74,0x0d,0x0a,
  0x0d,0x0a,0x00,0x01,0xfe,0xff
]);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-eml-export-'));
const target = path.join(dir, 'message.eml');
try {
  fs.writeFileSync(target, sample);
  const exported = fs.readFileSync(target);
  assert.strictEqual(Buffer.compare(sample, exported), 0);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('[LibraMail] Tests export EML 0.4.5 : OK');
