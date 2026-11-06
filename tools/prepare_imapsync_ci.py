#!/usr/bin/env python3
"""Prepare pinned imapsync 2.314 sources for LibraMail GitHub Actions.

Linux: verify the upstream tarball and stage its Perl source for PAR::Packer.
Windows: verify the upstream ZIP with a repository-approved SHA-256 and stage
its native standalone imapsync.exe. Does not accept an unverified digest.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import tarfile
import urllib.request
import zipfile

VERSION = "2.314"
UPSTREAM = "https://imapsync.lamiral.info/dist2"
LINUX_ARCHIVE = f"imapsync-{VERSION}.tgz"
WINDOWS_ARCHIVE = f"imapsync_{VERSION}.zip"
# FreeBSD ports and Fossies independently list the hash of this exact release.
LINUX_SHA256 = "34e1715c6584889ff3bd9c0acc2fab254446282beda90c8e5a71a83b3a59dbca"
HEX_SHA256 = re.compile(r"[0-9a-fA-F]{64}\Z")


def check_sha256(path: Path, expected: str) -> None:
    if not HEX_SHA256.fullmatch(expected):
        raise ValueError("Empreinte SHA-256 absente ou invalide : arrêt de sécurité")
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(data)
    if h.hexdigest() != expected.lower():
        raise ValueError(
            f"SHA-256 invalide pour {path.name}. Attendu {expected.lower()}, obtenu {h.hexdigest()}"
        )
    print(f"[imapsync] SHA-256 vérifié : {path.name}")


def download_if_missing(url: str, target: Path) -> None:
    if target.is_file():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".partial")
    try:
        print(f"[imapsync] Téléchargement {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "LibraMail-CI/0.6.2"})
        with urllib.request.urlopen(req, timeout=90) as response, temporary.open("wb") as out:
            shutil.copyfileobj(response, out)
        if not temporary.stat().st_size:
            raise ValueError("Archive téléchargée vide")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def read_linux_member(archive: Path, name: str) -> bytes:
    with tarfile.open(archive, "r:gz") as t:
        matches = [m for m in t.getmembers() if m.name.removeprefix("./") == f"imapsync-{VERSION}/{name}"]
        if len(matches) != 1 or not matches[0].isfile():
            raise ValueError(f"Membre Linux manquant ou invalide : {name}")
        if matches[0].size > 5_000_000:
            raise ValueError(f"Membre trop volumineux : {name}")
        handle = t.extractfile(matches[0])
        if handle is None:
            raise ValueError(f"Membre illisible : {name}")
        return handle.read()


def read_windows_member(archive: Path, name: str) -> bytes:
    with zipfile.ZipFile(archive) as z:
        matches = [m for m in z.infolist()
                   if Path(m.filename.replace("\\", "/")).name.lower() == name.lower()
                   and not m.is_dir()]
        if not matches:
            raise ValueError(f"Membre Windows manquant : {name}")
        # The official ZIP may contain build subdirectories: prefer the file at
        # the archive root (or directly inside its top-level version folder).
        min_depth = min(len(Path(m.filename.replace("\\", "/")).parts) for m in matches)
        candidates = [m for m in matches if len(Path(m.filename.replace("\\", "/")).parts) == min_depth]
        if len(candidates) != 1:
            raise ValueError(f"Membre Windows ambigu : {name}")
        member = candidates[0]
        if member.file_size > 150_000_000:
            raise ValueError(f"Membre trop volumineux : {name}")
        return z.read(member)


def windows_license_text(archive: Path, linux_license_archive: Path | None = None) -> tuple[bytes, str]:
    """Get NLPL license from Windows ZIP, or pinned Linux source if absent.

    The official imapsync_2.314.zip is known not to bundle LICENSE, while the
    exact same release's Linux source tarball does.  Never fetch an unverified
    license or accept an ambiguous member from a ZIP.
    """
    try:
        return read_windows_member(archive, "LICENSE"), WINDOWS_ARCHIVE
    except ValueError as error:
        if str(error) != "Membre Windows manquant : LICENSE":
            raise

    source = linux_license_archive or Path(".cache") / "imapsync" / LINUX_ARCHIVE
    if linux_license_archive is None:
        download_if_missing(f"{UPSTREAM}/{LINUX_ARCHIVE}", source)
    check_sha256(source, LINUX_SHA256)
    license_text = read_linux_member(source, "LICENSE")
    print(f"[imapsync] LICENSE récupérée depuis l'archive source vérifiée {LINUX_ARCHIVE}")
    return license_text, LINUX_ARCHIVE


def stage(archive: Path, platform: str, expected_hash: str, dest: Path,
          linux_license_archive: Path | None = None) -> None:
    check_sha256(archive, expected_hash)
    if platform == "linux":
        binary = read_linux_member(archive, "imapsync")
        if not binary.startswith(b"#!"):
            raise ValueError("imapsync Linux n'est pas un script exécutable attendu")
        target = dest / "imapsync"
        license_text = read_linux_member(archive, "LICENSE")
        license_source = LINUX_ARCHIVE
    else:
        binary = read_windows_member(archive, "imapsync.exe")
        if not binary.startswith(b"MZ"):
            raise ValueError("imapsync.exe ne contient pas un en-tête PE valide")
        target = dest / "imapsync.exe"
        license_text, license_source = windows_license_text(archive, linux_license_archive)

    # All artifacts are verified and readable before writing anything to runtime.
    dest.mkdir(parents=True, exist_ok=True)
    target.write_bytes(binary)
    if platform == "linux":
        target.chmod(0o755)
    (dest / "LICENSE").write_bytes(license_text)
    (dest / "UPSTREAM.txt").write_text(
        f"imapsync {VERSION} — https://imapsync.lamiral.info/\n"
        f"Archive : {archive.name}\nSHA-256 : {expected_hash.lower()}\n"
        f"Licence NLPL : {license_source}\n",
        encoding="utf-8",
    )
    print(f"[imapsync] Moteur officiel {VERSION} préparé : {target}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform", choices=("linux", "windows"))
    parser.add_argument("--archive", type=Path, help="Archive déjà téléchargée (toujours vérifiée)")
    parser.add_argument("--dest", type=Path, default=Path("runtime/imapsync"))
    args = parser.parse_args()
    if args.platform == "linux":
        filename = LINUX_ARCHIVE
        expected_hash = LINUX_SHA256
    else:
        filename = WINDOWS_ARCHIVE
        expected_hash = os.environ.get("IMAPSYNC_WINDOWS_ZIP_SHA256", "").strip()
        if not HEX_SHA256.fullmatch(expected_hash):
            raise SystemExit(
                "[imapsync] SHA-256 Windows non configuré. Définissez la variable GitHub "
                "IMAPSYNC_WINDOWS_ZIP_SHA256 avec le hash vérifié de imapsync_2.314.zip. "
                "Aucun téléchargement non vérifié n'est accepté."
            )
    archive = args.archive if args.archive is not None else Path(".cache") / "imapsync" / filename
    if args.archive is None:
        download_if_missing(f"{UPSTREAM}/{filename}", archive)
    stage(archive, args.platform, expected_hash, args.dest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
