'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'resources', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'resources', 'js', 'app.js'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'engine', 'backend.js'), 'utf8');
const dialog = fs.readFileSync(path.join(root, 'engine', 'lib', 'native_dialog.js'), 'utf8');
const fr = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'locales', 'fr.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'locales', 'en.json'), 'utf8'));

assert(index.includes('id="btn-bulk-export-eml"'));
assert(index.indexOf('id="btn-select-all"') < index.indexOf('id="list-title"'));

assert(app.includes('// LibraMail 0.4.6 — Ctrl+A contextuel et export EML multiple.'));
assert(app.includes('function handleGlobalSelectAllShortcut(event)'));
assert(app.includes("document.addEventListener('keydown', handleGlobalSelectAllShortcut);"));
assert(app.includes("document.getElementById('btn-bulk-export-eml').onclick = runBulkExportEml;"));
assert(app.includes("rpc('messages.exportSelectionEml'"));

assert(dialog.includes('async function showDirectoryDialog('));
assert(dialog.includes('System.Windows.Forms.FolderBrowserDialog'));
assert(dialog.includes("'--getexistingdirectory'"));
assert(dialog.includes('choose folder with prompt'));

const marker = '// LibraMail 0.4.6 — export EML multiple sans reconstruction.';
const start = backend.indexOf(marker);
const end = backend.indexOf("'messages.read': async", start);
assert(start >= 0 && end > start);
const block = backend.slice(start, end);
assert(block.includes('const messages = resolveSelection(items);'));
assert(block.includes('const raw = readLocalMessage(message);'));
assert(block.includes("fs.writeFileSync(target, raw, { flag: 'wx' });"));
assert(block.includes('fs.existsSync(target)'));
assert(!block.includes('simpleParser('));

assert.strictEqual(fr['emlExport.selectionAction'], 'Exporter la sélection en .eml');
assert.strictEqual(en['emlExport.selectionAction'], 'Export selection as .eml');

console.log('[LibraMail] Tests sélection + export EML multiple 0.4.6 : OK');
