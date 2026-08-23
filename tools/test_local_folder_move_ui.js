'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(
  path.join(__dirname, '..', 'resources', 'js', 'app.js'),
  'utf8'
);
const css = fs.readFileSync(
  path.join(__dirname, '..', 'resources', 'css', 'app.css'),
  'utf8'
);

assert(
  app.includes('// LibraMail 0.4.4 — déplacement des dossiers locaux par Pointer Events'),
  'Marqueur déplacement dossiers absent'
);
assert(
  app.includes('wireLocalFolderTreePointerDrag(button, row, folder);'),
  'Le bouton de dossier ne câble pas le drag Pointer Events'
);
assert(
  app.includes('localFolderTreeDropTargetAtPoint'),
  'Le hit-test des cibles dossiers est absent'
);
assert(
  app.includes("rpc('localFolders.update'"),
  'Le déplacement ne passe pas par le RPC localFolders.update'
);

assert(
  app.includes('libramail:local-folder-drag-start'),
  'Le drag des messages a disparu'
);
assert(
  app.includes('assignItemsToLocalFolder(items, folder)'),
  'Le classement message vers dossier a disparu'
);

assert(
  css.includes('/* LibraMail 0.4.4 — déplacement des dossiers locaux */'),
  'Styles du drag de dossiers absents'
);
assert(
  css.includes('.local-folder-tree-drag-source'),
  'Style source du drag de dossiers absent'
);
assert(
  css.includes('.local-folder-tree-drop-target'),
  'Style cible du drag de dossiers absent'
);

console.log('[LibraMail] Tests UI déplacement dossiers locaux : OK');
