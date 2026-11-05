#!/usr/bin/env python3
"""Generate public bilingual release notes and README highlights from CHANGELOG.md.

No API, translation service, account access or dependency outside Python stdlib.
The source changelog must already contain accurate FR and EN text.
"""
from __future__ import annotations

import argparse
import datetime as dt
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION_RE = r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?"
HEADER_RE = re.compile(rf"^# LibraMail (?P<version>{VERSION_RE}) - (?P<date>\d{{4}}-\d{{2}}-\d{{2}})\s*$", re.M)
NOTES_PATH = ROOT / ".github/release-notes.md"
README_PATH = ROOT / "README.md"
CHANGELOG_PATH = ROOT / "CHANGELOG.md"
MARKERS = {
    "EN": ("<!-- LIBRAMAIL:RELEASE-EN:START -->", "<!-- LIBRAMAIL:RELEASE-EN:END -->", "## Highlights"),
    "FR": ("<!-- LIBRAMAIL:RELEASE-FR:START -->", "<!-- LIBRAMAIL:RELEASE-FR:END -->", "## Fonctions principales"),
}


class PublicationError(ValueError):
    pass


def current_version(root: Path) -> str:
    path = root / "VERSION"
    if not path.is_file():
        raise PublicationError("VERSION introuvable")
    version = path.read_text(encoding="utf-8").strip()
    if not re.fullmatch(VERSION_RE, version):
        raise PublicationError(f"Version invalide dans VERSION : {version}")
    return version


def get_release(changelog: str, version: str) -> tuple[str, str, str]:
    matches = list(HEADER_RE.finditer(changelog))
    if not matches:
        raise PublicationError("Aucune section '# LibraMail X.Y.Z - AAAA-MM-JJ' dans CHANGELOG.md")
    target = [i for i, match in enumerate(matches) if match.group("version") == version]
    if len(target) != 1:
        raise PublicationError(f"La version {version} doit apparaître exactement une fois dans CHANGELOG.md")
    if target[0] != 0:
        raise PublicationError(f"La version {version} doit être la première entrée de CHANGELOG.md")

    matched = matches[0]
    release_date = matched.group("date")
    try:
        dt.date.fromisoformat(release_date)
    except ValueError as exc:
        raise PublicationError(f"Date incorrecte dans CHANGELOG.md : {release_date}") from exc
    content = changelog[matched.end(): matches[1].start() if len(matches) > 1 else len(changelog)]
    # Prevent an obsolete/manual horizontal rule from ending up in the release description.
    content = re.sub(r"(?:\n\s*---\s*)+$", "", content).strip()
    sections = list(re.finditer(r"^## (Français|English)\s*$", content, re.M))
    if [s.group(1) for s in sections] != ["Français", "English"]:
        raise PublicationError(
            f"CHANGELOG.md {version} doit contenir, dans cet ordre, '## Français' puis '## English'. "
            "Complète les deux langues avant publication ; aucune traduction n'est inventée."
        )
    if content[:sections[0].start()].strip():
        raise PublicationError("Place le contenu de cette version sous '## Français' et '## English'")
    fr = content[sections[0].end():sections[1].start()].strip()
    en = content[sections[1].end():].strip()
    for language, body in (("Français", fr), ("English", en)):
        if not body or not re.search(r"^-\s+\S", body, re.M):
            raise PublicationError(f"La section {language} doit contenir au moins une amélioration en liste")
        if re.search(r"\b(TODO|TBD|FIXME)\b", body, re.I):
            raise PublicationError(f"La section {language} contient du texte provisoire")
    return release_date, fr, en


def highlights(body: str) -> list[str]:
    """Round-robin sampling from subsections so bugfixes are not lost to the top section."""
    groups: list[list[str]] = []
    current: list[str] = []
    is_verification = False
    for line in body.splitlines():
        if line.startswith("### "):
            if current and not is_verification:
                groups.append(current)
            is_verification = bool(re.search(r"vérification|verification|tests?\b", line, re.I))
            current = []
        elif line.startswith("- "):
            current.append(line.strip())
    if current and not is_verification:
        groups.append(current)
    if not groups:
        return []
    result: list[str] = []
    for i in range(max(map(len, groups))):
        for group in groups:
            if i < len(group):
                result.append(group[i])
                if len(result) == 4:
                    return result
    return result


def readme_section(version: str, date: str, body: str, lang: str) -> str:
    start, end, _ = MARKERS[lang]
    title = "Latest version" if lang == "EN" else "Dernière version"
    label = "Full release notes" if lang == "EN" else "Notes de version complètes"
    bullet_lines = highlights(body)
    if not bullet_lines:
        raise PublicationError(f"Aucun point à afficher dans le README ({lang})")
    return "\n".join((
        start,
        f"## {title} — {version} ({date})",
        "",
        *bullet_lines,
        "",
        f"[{label}](https://github.com/technifree/LibraMail/releases/tag/v{version}) · [CHANGELOG](CHANGELOG.md)",
        end,
    ))


def replace_block(readme: str, lang: str, block: str) -> str:
    start, end, anchor = MARKERS[lang]
    if (start in readme) != (end in readme):
        raise PublicationError(f"README.md : marqueurs de la rubrique {lang} incomplets")
    if start in readme:
        if readme.count(start) != 1 or readme.count(end) != 1:
            raise PublicationError(f"README.md : marqueurs dupliqués ({lang})")
        before, remainder = readme.split(start, 1)
        _, after = remainder.split(end, 1)
        return before + block + after
    if readme.count(anchor) != 1:
        raise PublicationError(f"README.md : insertion impossible, ancre '{anchor}' manquante ou ambiguë")
    return readme.replace(anchor, block + "\n\n" + anchor, 1)


def render(root: Path, version: str) -> tuple[str, str]:
    changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
    date, fr, en = get_release(changelog, version)
    notes = (
        f"# LibraMail {version} — {date}\n\n"
        f"## Français\n\n{fr}\n\n"
        f"## English\n\n{en}\n\n"
        "### Downloads / Téléchargements\n\n"
        "- Linux x86_64 portable package and Debian package (`.deb`)\n"
        "- Windows x86_64 portable package\n"
        "- SHA-256 checksums for verification\n\n"
        "Public packages contain no account, password or message data.\n"
        "Les paquets publics ne contiennent aucun compte, mot de passe ou message.\n"
    )
    readme = (root / "README.md").read_text(encoding="utf-8")
    readme = replace_block(readme, "EN", readme_section(version, date, en, "EN"))
    readme = replace_block(readme, "FR", readme_section(version, date, fr, "FR"))
    footer = f"_Last documentation update / Dernière mise à jour : {date}._"
    old_footer = r"_Last documentation update / Dernière mise à jour\s*:[^\n]+_"
    if re.search(old_footer, readme):
        readme = re.sub(old_footer, footer, readme)
    else:
        readme = readme.rstrip() + "\n\n" + footer + "\n"
    return notes, readme


def main() -> int:
    parser = argparse.ArgumentParser(description="Notes GitHub et README depuis CHANGELOG.md (FR/EN)")
    parser.add_argument("version", nargs="?", help="X.Y.Z ; par défaut, contenu de VERSION")
    parser.add_argument("--check", action="store_true", help="Vérifie sans modifier aucun fichier")
    parser.add_argument("--validate-only", action="store_true", help="Valide le CHANGELOG sans modifier les versions ou les fichiers")
    args = parser.parse_args()
    try:
        actual_version = current_version(ROOT)
        version = args.version or actual_version
        if not re.fullmatch(VERSION_RE, version):
            raise PublicationError(f"Version invalide : {version}")
        if args.validate_only:
            get_release((ROOT / "CHANGELOG.md").read_text(encoding="utf-8"), version)
            print(f"[PUBLICATION] CHANGELOG FR/EN valide pour {version}")
            return 0
        if version != actual_version:
            raise PublicationError(f"VERSION contient {actual_version}, pas {version} ; synchroniser la version d'abord")
        notes, readme = render(ROOT, version)
        targets = ((NOTES_PATH, notes), (README_PATH, readme))
        if args.check:
            outdated = [str(p.relative_to(ROOT)) for p, value in targets if not p.is_file() or p.read_text(encoding="utf-8") != value]
            if outdated:
                raise PublicationError(
                    "Documents de publication absents ou non synchronisés : " + ", ".join(outdated)
                    + f". Exécuter ./github.sh notes {version}"
                )
            print(f"[PUBLICATION] OK : notes FR/EN et README synchronisés pour {version}")
        else:
            for p, value in targets:
                p.parent.mkdir(parents=True, exist_ok=True)
                if not p.exists() or p.read_text(encoding="utf-8") != value:
                    p.write_text(value, encoding="utf-8")
                    print(f"[PUBLICATION] Mis à jour : {p.relative_to(ROOT)}")
            print(f"[PUBLICATION] Notes FR/EN générées depuis CHANGELOG.md pour {version}")
    except (PublicationError, OSError) as exc:
        print(f"[PUBLICATION] ERREUR : {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
