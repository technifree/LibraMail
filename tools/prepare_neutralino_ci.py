#!/usr/bin/env python3
"""Preload pinned Neutralino binaries for LibraMail CI builds (no `neu update`).

Use the exact official v6.8.0 release asset and its GitHub-published SHA-256.
Reject HTML/error pages, corrupt/truncated ZIPs and unexpected binaries. A
SourceForge mirror is used only if its bytes match the *same* official digest.
This program modifies only ignored build artifacts under bin/.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PINNED = '6.8.0'
TARGETS = {
    'linux-x64': ('neutralino-linux_x64', b'\x7fELF'),
    'windows-x64': ('neutralino-win_x64.exe', b'MZ'),
    'macos-x64': ('neutralino-mac_x64', None),
    'macos-arm64': ('neutralino-mac_arm64', None),
}
MAX_SIZE = 32 * 1024 * 1024


def require_pinned_config(config_path: Path) -> None:
    config = json.loads(config_path.read_text(encoding='utf-8'))
    value = config.get('cli', {}).get('binaryVersion')
    if value != PINNED:
        raise RuntimeError(f'Neutralino version must remain {PINNED}, got {value!r}')


def get_upstream_digest(asset: str) -> str:
    cmd = ['gh', 'api', f'repos/neutralinojs/neutralinojs/releases/tags/v{PINNED}']
    completed = subprocess.run(cmd, text=True, capture_output=True, check=True, timeout=45)
    meta = json.loads(completed.stdout)
    matches = [item for item in meta.get('assets', []) if item.get('name') == asset]
    if len(matches) != 1:
        raise RuntimeError(f'Official Neutralino v{PINNED} asset not found: {asset}')
    digest = matches[0].get('digest', '')
    if not re.fullmatch(r'sha256:[a-fA-F0-9]{64}', digest):
        raise RuntimeError('GitHub asset has no SHA-256 digest: refuse an unverified download')
    return digest.split(':', 1)[1].lower()


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as fd:
        for block in iter(lambda: fd.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def check_archive(path: Path, expected: str) -> None:
    if not path.is_file() or not 100_000 < path.stat().st_size < MAX_SIZE:
        raise RuntimeError('Neutralino archive size is invalid (HTML/error page or incomplete)')
    actual = sha256(path)
    if actual != expected:
        raise RuntimeError(f'Neutralino SHA-256 mismatch (expected {expected}, received {actual})')
    try:
        with zipfile.ZipFile(path) as zf:
            if zf.testzip() is not None:
                raise RuntimeError('Neutralino archive failed CRC verification')
    except zipfile.BadZipFile as exc:
        raise RuntimeError('Neutralino archive is not a valid ZIP') from exc


def fetch_asset(asset: str, expected: str, temp: Path) -> Path:
    dest = temp / asset
    errors = []
    for attempt in range(1, 3):
        try:
            dest.unlink(missing_ok=True)
            subprocess.run(
                ['gh', 'release', 'download', f'v{PINNED}', '--repo', 'neutralinojs/neutralinojs',
                 '--pattern', asset, '--dir', str(temp)],
                check=True, timeout=100, capture_output=True, text=True,
            )
            check_archive(dest, expected)
            print(f'[Neutralino] Official GitHub asset validated on attempt {attempt}.')
            return dest
        except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
            errors.append(f'GitHub attempt {attempt}: {exc}')
            if attempt < 2:
                time.sleep(2)

    # Secondary distribution is acceptable only with the official GitHub SHA.
    mirror = f'https://downloads.sourceforge.net/project/neutralinojs/v{PINNED}/{asset}'
    try:
        dest.unlink(missing_ok=True)
        req = urllib.request.Request(mirror, headers={'User-Agent': 'LibraMail-Neutralino-CI/0.6.3'})
        with urllib.request.urlopen(req, timeout=50) as source, dest.open('wb') as output:
            copied = 0
            while chunk := source.read(1024 * 1024):
                copied += len(chunk)
                if copied > MAX_SIZE:
                    raise RuntimeError('SourceForge response exceeds ZIP size limit')
                output.write(chunk)
        check_archive(dest, expected)
        print('[Neutralino] Mirrored asset validated against official GitHub SHA-256.')
        return dest
    except Exception as exc:
        errors.append(f'SourceForge mirror: {exc}')
        raise RuntimeError('No trustworthy Neutralino binary archive available:\n' + '\n'.join(errors)) from exc


def install_target(archive: Path, dest: Path, target: str) -> Path:
    name, magic = TARGETS[target]
    with zipfile.ZipFile(archive) as zf:
        candidates = [item for item in zf.infolist() if not item.is_dir() and
                      Path(item.filename.replace('\\', '/')).name == name]
        if len(candidates) != 1:
            raise RuntimeError(f'Expected exactly one {name} in Neutralino archive, got {len(candidates)}')
        member = candidates[0]
        if not 30_000 < member.file_size < MAX_SIZE:
            raise RuntimeError(f'{name}: invalid decompressed binary size')
        dest.mkdir(parents=True, exist_ok=True)
        output = dest / name
        temporary = dest / (name + '.part')
        try:
            with zf.open(member, 'r') as src, temporary.open('wb') as out:
                shutil.copyfileobj(src, out)
            with temporary.open('rb') as fd:
                header = fd.read(4)
            if magic is not None and not header.startswith(magic):
                raise RuntimeError(f'{name} is not a valid native executable header')
            if target.startswith('macos') and header not in (
                b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf',
                b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca',
                b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca',
            ):
                raise RuntimeError(f'{name} is not a Mach-O executable')
            temporary.chmod(0o755)
            os.replace(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)
        return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=sorted(TARGETS), required=True)
    args = parser.parse_args()
    require_pinned_config(ROOT / 'neutralino.config.json')
    asset = f'neutralinojs-v{PINNED}.zip'
    official_sha = get_upstream_digest(asset)
    with tempfile.TemporaryDirectory(prefix='libramail-neutralino-ci-') as td:
        archive = fetch_asset(asset, official_sha, Path(td))
        output = install_target(archive, ROOT / 'bin', args.target)
    print(f'[Neutralino] v{PINNED} SHA-256 {official_sha}; {output.name} installed ({output.stat().st_size} bytes).')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError, ValueError, zipfile.BadZipFile) as exc:
        print(f'[Neutralino] ERROR: {exc}', file=sys.stderr)
        sys.exit(1)
