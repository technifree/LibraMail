#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
const generator = fs.readFileSync(path.join(root, 'tools/generate_release_notes.py'), 'utf8');
const notes = fs.readFileSync(path.join(root, '.github/release-notes.md'), 'utf8');
const releaseScript = fs.readFileSync(path.join(root, 'release.sh'), 'utf8');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const env = {...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8'};
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();

assert(workflow.includes('steps.macos_policy.outputs.enabled'), 'Release must use version gate');
assert(workflow.includes('git merge-base --is-ancestor HEAD refs/remotes/origin/master'), 'Tag from dev branch must not be published');
assert(workflow.includes("(0, 6, 3)"), 'Legacy releases must not require macOS');
assert(workflow.includes('macos-15-intel') && workflow.includes('macos-15'));
assert(workflow.includes('tools/smoke_macos_package.sh'), 'Package smoke test must gate each Mac release');
assert(workflow.indexOf('bash tools/smoke_macos_package.sh') < workflow.indexOf('name: Upload experimental macOS release assets'), 'Mac smoke test must precede release upload');
assert(workflow.includes('prepare_macos_release_assets.py'), 'Release must relabel experimental Mac archives');
assert(workflow.includes('needs.macos.result == \'success\''), 'macOS build failure must block publication');
assert(workflow.includes("needs.macos.result == 'skipped' && needs.verify.outputs.macos_enabled == 'false'"), 'Only legacy releases may skip macOS');
assert(workflow.includes('pattern: release-*') && workflow.includes('merge-multiple: true'));
assert(workflow.includes('sha256sum -c "$asset.sha256"'), 'Release must verify Mac checksums before publishing');
assert(workflow.includes('actions/download-artifact@v6'), 'Artifact download should support the current Node runner');
assert(releaseScript.includes('[[ "$BRANCH" == master ]]'), 'Do not tag the development branch');
assert(generator.includes('macOS Intel x86_64 and Apple Silicon arm64'));
assert(notes.includes('macos') || notes.includes('macOS'));
assert(notes.includes('EXPÉRIMENTAUX') && notes.includes('EXPERIMENTAL'), 'Release notes must disclose experimental Mac packages in FR and EN');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-macos-release-'));
try {
  const source = path.join(dir, 'build');
  const output = path.join(dir, 'release');
  fs.mkdirSync(source);
  const create = spawnSync(python, ['-c', `
from pathlib import Path
import hashlib,plistlib,zipfile
root=Path(${JSON.stringify(source)})
for arch in ('x86_64','arm64'):
 name=f'LibraMail-${version}-macos-{arch}.zip'
 archive=root/name
 with zipfile.ZipFile(archive,'w') as z:
  prefix='LibraMail.app/Contents/'
  z.writestr(prefix+'Info.plist',plistlib.dumps({'CFBundleShortVersionString': '${version}'}))
  for part in ('MacOS/LibraMail','Resources/app/runtime/node/bin/node','Resources/app/runtime/imapsync/imapsync','Resources/app/engine/backend.js','Resources/app/bin/libramail-app'):
   z.writestr(prefix+part,b'not executable: fake fixture')
 digest=hashlib.sha256(archive.read_bytes()).hexdigest()
 (root/(name+'.sha256')).write_text(f'{digest}  {name}\\n')
`], {env, encoding: 'utf8'});
  assert.equal(create.status, 0, create.stderr);
  const helper = path.join(root, 'tools/prepare_macos_release_assets.py');
  function run(arch, target = output) {
    return spawnSync(python, [helper, '--version', version, '--arch', arch, '--source', source, '--dest', target], {encoding: 'utf8', env});
  }
  for (const arch of ['x86_64', 'arm64']) {
    const r = run(arch);
    assert.equal(r.status, 0, r.stderr);
    const filename = `LibraMail-${version}-macos-${arch}-experimental.zip`;
    assert(fs.existsSync(path.join(output, filename)));
    const verify = spawnSync(python, ['-c', `
import hashlib,os,sys
name=sys.argv[1]
with open(name+'.sha256',encoding='utf8') as f: expected,filename=f.read().split()
assert filename==os.path.basename(name)
assert hashlib.sha256(open(name,'rb').read()).hexdigest()==expected
`, path.join(output, filename)], {env, encoding:'utf8'});
    assert.equal(verify.status, 0, verify.stderr);
  }
  const replay = run('arm64');
  assert.notEqual(replay.status, 0, 'Existing artifact must not be overwritten');
  const checksumPath = path.join(source, `LibraMail-${version}-macos-arm64.zip.sha256`);
  fs.writeFileSync(checksumPath, '0'.repeat(64) + `  LibraMail-${version}-macos-arm64.zip\n`);
  const altered = run('arm64', path.join(dir, 'altered'));
  assert.notEqual(altered.status, 0, 'Corrupted source checksum accepted');
  const wrongVersion = spawnSync(python, [helper,'--version','0.6.9','--arch','x86_64','--source',source,'--dest',path.join(dir,'bad')], {env, encoding:'utf8'});
  assert.notEqual(wrongVersion.status, 0, 'Mismatched version accepted');
} finally {
  fs.rmSync(dir, {recursive:true,force:true});
}
console.log('[OK] LibraMail 0.6.3: publication macOS expérimentale, checksums, versions et verrouillage de sécurité');
