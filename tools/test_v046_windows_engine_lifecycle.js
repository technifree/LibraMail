'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'app.js'), 'utf8');

assert(app.includes('// LibraMail 0.4.6 — journal Windows persistant et arrêt de secours ciblé.'));
assert(app.includes('===== Nouvelle session LibraMail ====='));
assert(app.includes('Neutralino.filesystem.readFile(logPath)'));
assert(app.includes('previousLines.slice(-180)'));
assert(app.includes('bundledEngineStartupLog.slice(-240)'));
assert(app.includes('async function forceKillBundledWindowsEngine(processInfo'));
assert(app.includes('const osPid = Number(processInfo?.pid || 0);'));
assert(app.includes('taskkill.exe /PID ${osPid} /T /F'));
assert(!app.includes('taskkill.exe /IM node.exe'));

console.log('[LibraMail] Tests cycle de vie moteur Windows 0.4.6 : OK');
