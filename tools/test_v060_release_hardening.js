#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const linux = read('build_linux.sh');
const windows = read('build_windows.ps1');
const buildWorkflow = read('.github/workflows/build.yml');
const releaseWorkflow = read('.github/workflows/release.yml');
const releaseScript = read('release.sh');
const securityCheck = read('security_check.sh');
const backend = read('engine/backend.js');
const lock = JSON.parse(read('engine/package-lock.json'));

assert(linux.includes('LIBRAMAIL_NODE_VERSION:-22.23.1'));
assert(linux.includes('Valeur par défaut : 22.23.1'));
assert(!linux.includes('LIBRAMAIL_NODE_VERSION:-24.18.0'));

assert(windows.includes("[string]$NodeVersion = '22.23.1'"));
assert(!windows.includes("[string]$NodeVersion = '24.18.0'"));

for (const workflow of [buildWorkflow, releaseWorkflow]) {
  assert(workflow.includes('node-version: "22.23.1"'));
  assert(workflow.includes('npm ci --omit=dev --no-audit --no-fund'));
  assert(workflow.includes('run: npm test'));
}

assert(buildWorkflow.includes('verify:\n'));
assert(buildWorkflow.includes('needs: verify'));
assert(releaseWorkflow.includes('Run complete test suite'));
assert(releaseScript.includes('./github.sh check'));

assert(securityCheck.includes("GOCSPX-"));
assert(securityCheck.includes("ya29\\."));
assert(securityCheck.includes("gh[pousr]_"));
assert(securityCheck.includes("PRIVATE KEY"));

const packages = lock.packages || {};
let resolvedCount = 0;
for (const [name, meta] of Object.entries(packages)) {
  if (!meta || !meta.resolved) continue;
  resolvedCount += 1;
  const host = new URL(meta.resolved).hostname;
  assert.strictEqual(host, 'registry.npmjs.org', `hôte npm inattendu pour ${name}: ${host}`);
  assert(meta.integrity, `intégrité npm absente pour ${name}`);
}
assert(resolvedCount > 50, 'package-lock doit contenir les dépendances résolues');

assert(
  backend.includes("process.env.LIBRAMAIL_GOOGLE_CALENDAR_MOCK === '1'"),
  'le simulateur Google doit rester strictement opt-in',
);

const sourceFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|sh|ps1|bat|yml|yaml|json|md|html|css)$/.test(entry.name)) sourceFiles.push(full);
  }
}
for (const dir of ['engine', 'resources', 'tools', '.github']) {
  const full = path.join(root, dir);
  if (fs.existsSync(full)) walk(full);
}
sourceFiles.push(path.join(root, 'build_linux.sh'));
sourceFiles.push(path.join(root, 'build_windows.ps1'));
sourceFiles.push(path.join(root, 'release.sh'));

for (const file of sourceFiles) {
  if (file.endsWith('test_v060_release_hardening.js')) continue;
  if (file.endsWith('engine/package-lock.json')) continue;
  const text = fs.readFileSync(file, 'utf8');
  assert(!/\b(TODO|FIXME|HACK|XXX)\b/.test(text), `marque de développement restante : ${path.relative(root, file)}`);
}

console.log('[LibraMail] Test durcissement pré-release 0.6.0 : OK');
