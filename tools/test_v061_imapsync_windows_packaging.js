#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ps1 = fs.readFileSync(path.join(root, 'build_windows.ps1'), 'utf8');
const bat = fs.readFileSync(path.join(root, 'build_windows.bat'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'packaging', 'windows', 'README_WINDOWS.txt.in'), 'utf8');

const ps1Tokens = [
  'LibraMail 0.6.1 - imapsync Windows packaging',
  '[switch]$WithoutImapsync',
  'Install-ImapsyncRuntime',
  'runtime\\imapsync\\imapsync.exe',
  'Le moteur imapsync attendu est absent du paquet final.'
];

for (const token of ps1Tokens) {
  if (!ps1.includes(token)) {
    throw new Error(`build_windows.ps1 incomplet : ${token}`);
  }
}

if (!bat.includes('--without-imapsync=-WithoutImapsync')) {
  throw new Error('build_windows.bat ne relaie pas --without-imapsync.');
}

if (!readme.includes('.\\runtime\\imapsync\\imapsync.exe')) {
  throw new Error('README Windows sans documentation imapsync.');
}

console.log('[OK] Packaging Windows imapsync 0.6.1');
