#!/usr/bin/env python3
"""Mark a validated macOS package as experimental, preserving its checksum.

Called only AFTER tools/smoke_macos_package.sh has succeeded on its native
macOS GitHub runner. No network access and no user data required.
"""
from __future__ import annotations

import argparse
import hashlib
import plistlib
import re
import shutil
import sys
from pathlib import Path
from zipfile import BadZipFile, ZipFile


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def prepare(version: str, arch: str, source: Path, dest: Path) -> tuple[Path, Path]:
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Version de release invalide')
    if arch not in ('x86_64', 'arm64'):
        raise ValueError('Architecture macOS invalide')
    original = f'LibraMail-{version}-macos-{arch}.zip'
    archive = source / original
    checksum = source / (original + '.sha256')
    if not archive.is_file() or not checksum.is_file():
        raise ValueError(f'Archive ou empreinte manquante : {original}')

    digest = sha256(archive)
    text = checksum.read_text(encoding='utf-8').strip()
    if text != f'{digest}  {original}':
        raise ValueError('Empreinte de la compilation source incohérente')
    try:
        with ZipFile(archive) as zipped:
            names = set(zipped.namelist())
            prefix = 'LibraMail.app/Contents/'
            required = (
                prefix + 'Info.plist',
                prefix + 'MacOS/LibraMail',
                prefix + 'Resources/app/runtime/node/bin/node',
                prefix + 'Resources/app/runtime/imapsync/imapsync',
                prefix + 'Resources/app/engine/backend.js',
                prefix + 'Resources/app/bin/libramail-app',
            )
            if any(name not in names for name in required):
                raise ValueError('LibraMail.app incomplet dans le ZIP')
            if any(name.startswith('LibraMail.app/Contents/Resources/app/data/') for name in names):
                raise ValueError('Le paquet contient des données applicatives')
            if zipped.testzip() is not None:
                raise ValueError('Archive ZIP corrompue')
            metadata = plistlib.loads(zipped.read(prefix + 'Info.plist'))
            if metadata.get('CFBundleShortVersionString') != version:
                raise ValueError('La version du paquet macOS ne correspond pas au tag')
    except (BadZipFile, OSError, plistlib.InvalidFileException) as exc:
        raise ValueError('Archive macOS illisible') from exc

    dest.mkdir(parents=True, exist_ok=True)
    target = dest / f'LibraMail-{version}-macos-{arch}-experimental.zip'
    if target.exists() or (dest / (target.name + '.sha256')).exists():
        raise ValueError('Le dossier de publication contient déjà cet artefact')
    shutil.copyfile(archive, target)
    result_checksum = dest / (target.name + '.sha256')
    result_checksum.write_text(f'{digest}  {target.name}\n', encoding='utf-8')
    if sha256(target) != digest:
        raise ValueError('Copie de l’archive macOS altérée')
    return target, result_checksum


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--version', required=True)
    parser.add_argument('--arch', required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--dest', type=Path, required=True)
    args = parser.parse_args()
    try:
        archive, checksum = prepare(args.version, args.arch, args.source, args.dest)
    except (ValueError, OSError) as exc:
        print(f'[macOS RELEASE] ERREUR : {exc}', file=sys.stderr)
        return 1
    print(f'[macOS RELEASE] EXPÉRIMENTAL : {archive.name} ; {checksum.name}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
