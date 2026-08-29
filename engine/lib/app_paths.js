'use strict';

const path = require('path');

// LibraMail 0.4.8 — chemins d'état configurables.
//
// Mode portable (comportement historique) :
//   stateRoot = <racine LibraMail>
//   data      = <racine LibraMail>/data
//   backups   = <racine LibraMail>/backups
//
// Mode installé : le lanceur définit LIBRAMAIL_STATE_ROOT, par exemple
//   ~/.local/share/libramail
// et toutes les écritures persistantes restent alors hors de /opt.
function createAppPaths(appRoot, env = process.env) {
  const root = path.resolve(String(appRoot || '.'));
  const requestedStateRoot = String(env?.LIBRAMAIL_STATE_ROOT || '').trim();
  const stateRoot = requestedStateRoot
    ? path.resolve(requestedStateRoot)
    : root;

  return {
    root,
    stateRoot,
    dataDir: path.join(stateRoot, 'data'),
    backupsDir: path.join(stateRoot, 'backups'),
    restoreStateFile: path.join(stateRoot, '.libramail-restore-state.json'),
    portable: stateRoot === root,
  };
}

function isInsideStateRoot(candidate, stateRoot) {
  const root = path.resolve(String(stateRoot || '.'));
  const resolved = path.resolve(String(candidate || ''));
  return resolved !== root && resolved.startsWith(root + path.sep);
}

module.exports = {
  createAppPaths,
  isInsideStateRoot,
};
