#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
const macBuild = fs.readFileSync(path.join(root, 'build_macos.sh'), 'utf8');
const helper = path.join(root, 'tools/prepare_neutralino_ci.py');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const env = {...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8'};
assert(fs.existsSync(helper));
for (const target of ['linux-x64', 'windows-x64', 'macos-x64', 'macos-arm64']) {
  assert(workflow.includes(`--target ${target}`), `Missing Neutralino CI preload for ${target}`);
}
assert(workflow.includes('GH_TOKEN: ${{ github.token }}'), 'Release must authorize official asset lookup');
assert(workflow.includes('tools/prepare_neutralino_ci.py|tools/test_v063_neutralino_ci.js'),
  'Only packaging tools may change after release tag during controlled replay');
assert(macBuild.includes('PINNED_NEU="$ROOT/bin/neutralino-mac_${NEU_ARCH}"'),
  'macOS must reuse a preverified native binary without neu update');
assert(macBuild.includes('neu update'), 'macOS local/non-CI fallback must remain operational');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-neu-test-'));
try {
  const script = `
import importlib.util, hashlib, io, pathlib, sys, zipfile
script = pathlib.Path(sys.argv[1])
workspace = pathlib.Path(sys.argv[2])
spec = importlib.util.spec_from_file_location('prepare_neutralino_ci', script)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
assert mod.PINNED == '6.8.0'
headers = {'linux-x64': b'\\x7fELF', 'windows-x64': b'MZ', 'macos-x64': b'\\xcf\\xfa\\xed\\xfe', 'macos-arm64': b'\\xcf\\xfa\\xed\\xfe'}
archive = workspace / 'fixture.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_STORED) as z:
 for target, (name, _) in mod.TARGETS.items():
  z.writestr('release/bin/' + name, headers[target] + b'\\x00' * 66000)
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
mod.check_archive(archive, digest)
for target in mod.TARGETS:
 result = mod.install_target(archive, workspace / target, target)
 assert result.stat().st_size > 30000
 assert result.read_bytes().startswith(headers[target])
try:
 mod.check_archive(archive, '0'*64)
 raise AssertionError('Hash mismatch not rejected')
except RuntimeError: pass
broken = workspace / 'broken.zip'
broken.write_bytes(b'<html>bad gateway</html>' * 10000)
try:
 mod.check_archive(broken, hashlib.sha256(broken.read_bytes()).hexdigest())
 raise AssertionError('Fake ZIP not rejected')
except RuntimeError: pass
print('Offline Neutralino CI integrity tests: OK')
`;
  const run = spawnSync(python, ['-c', script, helper, work], {env, encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr || run.stdout);
} finally {
  fs.rmSync(work, {recursive: true, force: true});
}
console.log('[OK] LibraMail 0.6.3 : recuperation Neutralino CI verifiee (SHA-256, ZIP et binaires)');
