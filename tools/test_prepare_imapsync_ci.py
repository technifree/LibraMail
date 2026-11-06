#!/usr/bin/env python3
"""Offline tests of checksum verification and constrained archive extraction."""
import hashlib
from io import BytesIO
from pathlib import Path
import tarfile
import tempfile
import unittest
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


if __name__ == '__main__':
    unittest.main()
