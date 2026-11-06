#!/usr/bin/env python3
"""Offline tests of checksum verification and constrained archive extraction."""
import hashlib
from io import BytesIO
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from prepare_imapsync_ci import check_sha256, stage, VERSION


class PrepareImapsyncTests(unittest.TestCase):
    def test_linux_stages_only_pinned_members(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'test.tgz'
            with tarfile.open(p, 'w:gz') as tar:
                for name, content in [('imapsync', b'#!/usr/bin/env perl\nprint 1;'), ('LICENSE', b'No limits')]:
                    info = tarfile.TarInfo(f'imapsync-{VERSION}/{name}')
                    info.size = len(content)
                    tar.addfile(info, BytesIO(content))
            h = hashlib.sha256(p.read_bytes()).hexdigest()
            dest = Path(tmp) / 'runtime'
            stage(p, 'linux', h, dest)
            self.assertEqual((dest / 'imapsync').read_bytes(), b'#!/usr/bin/env perl\nprint 1;')
            self.assertTrue((dest / 'imapsync').stat().st_mode & 0o100)
            self.assertEqual((dest / 'LICENSE').read_bytes(), b'No limits')
            with self.assertRaises(ValueError):
                check_sha256(p, '0' * 64)

    def test_windows_stages_only_pinned_exe(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'test.zip'
            with zipfile.ZipFile(p, 'w') as z:
                z.writestr(f'imapsync_{VERSION}/imapsync.exe', b'MZ' + b'\x00' * 128)
                z.writestr(f'imapsync_{VERSION}/LICENSE', b'No limits')
                z.writestr(f'imapsync_{VERSION}/Cook/LICENSE', b'another build license')
                z.writestr('../unwanted.txt', 'bad')
            h = hashlib.sha256(p.read_bytes()).hexdigest()
            dest = Path(tmp) / 'runtime'
            stage(p, 'windows', h, dest)
            self.assertTrue((dest / 'imapsync.exe').read_bytes().startswith(b'MZ'))
            self.assertEqual((dest / 'LICENSE').read_bytes(), b'No limits')
            self.assertFalse((Path(tmp) / 'unwanted.txt').exists())


    def test_windows_missing_license_uses_verified_linux_source(self):
        # Reproduces the exact failure of GitHub Actions: ZIP has exe but no LICENSE.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            windows_zip = root / 'win.zip'
            with zipfile.ZipFile(windows_zip, 'w') as z:
                z.writestr(f'imapsync_{VERSION}/imapsync.exe', b'MZ' + b'\0' * 128)
            win_hash = hashlib.sha256(windows_zip.read_bytes()).hexdigest()

            linux_tgz = root / 'source.tgz'
            with tarfile.open(linux_tgz, 'w:gz') as t:
                contents = b'No limits to do anything with this work and this license.\n'
                entry = tarfile.TarInfo(f'imapsync-{VERSION}/LICENSE')
                entry.size = len(contents)
                t.addfile(entry, BytesIO(contents))
            linux_hash = hashlib.sha256(linux_tgz.read_bytes()).hexdigest()

            with patch('prepare_imapsync_ci.LINUX_SHA256', linux_hash):
                stage(windows_zip, 'windows', win_hash, root / 'runtime', linux_tgz)
                self.assertEqual((root / 'runtime/LICENSE').read_bytes(), contents)
                self.assertIn(b'Licence NLPL : imapsync-2.314.tgz',
                              (root / 'runtime/UPSTREAM.txt').read_bytes())

            # Incorrect source digest must be rejected before runtime creation.
            with patch('prepare_imapsync_ci.LINUX_SHA256', '0' * 64):
                with self.assertRaisesRegex(ValueError, 'SHA-256 invalide'):
                    stage(windows_zip, 'windows', win_hash, root / 'bad-runtime', linux_tgz)
                self.assertFalse((root / 'bad-runtime').exists())

    def test_windows_ambiguous_license_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'win.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('imapsync.exe', b'MZ' + b'\0' * 128)
                z.writestr('one/LICENSE', b'one')
                z.writestr('two/LICENSE', b'two')
            hash_value = hashlib.sha256(archive.read_bytes()).hexdigest()
            with self.assertRaisesRegex(ValueError, 'Membre Windows ambigu'):
                stage(archive, 'windows', hash_value, root / 'runtime')
            self.assertFalse((root / 'runtime').exists())


if __name__ == '__main__':
    unittest.main()
