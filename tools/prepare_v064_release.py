#!/usr/bin/env python3
"""Prépare les métadonnées de la 0.6.4 sans modifier les fonctions ni publier.

Usage: python3 tools/prepare_v064_release.py [--date AAAA-MM-JJ]
Le script s'appuie sur les générateurs existants de LibraMail.
"""
from __future__ import annotations

import argparse
import datetime as dt
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = '0.6.4'
PREVIOUS = '0.6.3'

FR = """## Français

### Correction des pièces jointes

- L'ajout d'une ou plusieurs pièces jointes à un nouveau message utilise désormais le répertoire de données réel de LibraMail, y compris avec une installation Debian.
- Le transfert d'un message reprend automatiquement ses pièces jointes depuis le contenu MIME d'origine, sans imposer de les ajouter à nouveau.
- Il est possible de retirer une pièce jointe depuis la fenêtre de rédaction avant l'envoi.

### Sécurisation des envois

- L'envoi, l'enregistrement d'un brouillon et la programmation d'un envoi différé attendent la préparation des fichiers joints.
- Lorsqu'une pièce jointe est manquante ou inaccessible, l'envoi SMTP est bloqué au lieu d'expédier silencieusement un message incomplet.
- Les copies temporaires gérées par LibraMail sont nettoyées lorsqu'elles ne sont plus nécessaires.

### Vérifications

- Tests de non-régression couvrant plusieurs pièces jointes, le transfert MIME et l'intégrité binaire d'un PDF et d'une image.
"""

EN = """## English

### Attachment fixes

- Adding one or more attachments to a new message now uses LibraMail's actual writable data directory, including Debian installations.
- Forwarding a message automatically carries over its attachments from the original MIME message; recipients no longer receive a forward without the original files.
- Attachments can now be removed from the compose window before sending.

### Safer sending

- Sending, saving a draft and scheduling a message wait until attachment preparation has completed.
- If an attachment is missing or unreadable, SMTP sending is blocked instead of silently delivering an incomplete message.
- Temporary copies managed by LibraMail are cleaned up when no longer needed.

### Verification

- Regression tests cover multiple attachments, MIME forwarding and byte-for-byte integrity of PDF and image files.
"""

PUBLISHING_SECTION = """## macOS experimental packages (0.6.3+)

The official release workflow builds both Intel (`x86_64`) and Apple Silicon
(`arm64`) macOS packages, in addition to Linux and Windows. Both macOS jobs
must pass their automated smoke tests before publication. These packages
remain **experimental, unsigned and unnotarized**; the graphical application
has not been validated on physical Macs. See [MACOS_PREVIEW.md](MACOS_PREVIEW.md).

## Validation avant publication de la 0.6.4 / Before publishing 0.6.4

- Valider en conditions réelles la rédaction d'un message avec plusieurs pièces jointes, son transfert et un brouillon contenant des fichiers joints.
- Vérifier `./github.sh check`, les workflows `Verify sources` et les constructions macOS expérimentales sur `dev-0.6.4`.
- Vérifier les variables de construction `IMAPSYNC_WINDOWS_ZIP_SHA256` et `IMAPSYNC_MACOS_X64_SHA256` avant la Release.
- Fusionner `dev-0.6.4` dans `master` sans modifier ni déplacer le tag de la 0.6.3.
- Exécuter `./github.sh release 0.6.4` **uniquement sur `master`** après validation des workflows. La commande crée un tag et déclenche une publication publique.
- Mettre à jour la date des notes avec `python3 tools/prepare_v064_release.py --date AAAA-MM-JJ` si la publication a lieu après le 10 novembre 2026.
- Conserver la mention **expérimental** pour les deux versions macOS, non signées et non notarisées.
"""


def run(*args: str) -> None:
    subprocess.run(args, cwd=ROOT, check=True)


def replace_exact(text: str, before: str, after: str) -> str:
    if before in text:
        return text.replace(before, after)
    if after in text:
        return text
    raise ValueError(f"Motif de documentation introuvable : {before!r}")


def prepare(date: str) -> None:
    try:
        dt.date.fromisoformat(date)
    except ValueError as exc:
        raise ValueError('Date invalide : AAAA-MM-JJ attendu') from exc
    branch = subprocess.run(
        ['git', 'branch', '--show-current'], cwd=ROOT,
        text=True, capture_output=True, check=True,
    ).stdout.strip()
    if branch != 'dev-0.6.4':
        raise ValueError(f"Branche actuelle : {branch or '(aucune)'}. Utiliser dev-0.6.4, jamais master.")
    if not (ROOT / 'engine/lib/compose_attachments.js').is_file() or not (ROOT / 'tools/test_v064_attachments.js').is_file():
        raise ValueError('Correctif des pièces jointes 0.6.4 introuvable. Appliquer et valider celui-ci d’abord.')
    current = (ROOT / 'VERSION').read_text(encoding='utf-8').strip()
    if current not in (PREVIOUS, VERSION):
        raise ValueError(f"Version de départ inattendue : {current}")
    changelog_path = ROOT / 'CHANGELOG.md'
    changelog = changelog_path.read_text(encoding='utf-8')
    past = re.search(r'(?m)^# LibraMail 0\.6\.3 - \d{4}-\d{2}-\d{2}\s*$', changelog)
    if not past:
        raise ValueError('Entrée historique 0.6.3 absente du CHANGELOG : aucune modification effectuée.')
    prefix = changelog[:past.start()].strip()
    if prefix and not re.match(r'^# LibraMail 0\.6\.4 - \d{4}-\d{2}-\d{2}\s*$', prefix.splitlines()[0]):
        raise ValueError('Le CHANGELOG contient une autre version avant 0.6.3. Arrêt sans écrasement.')
    if re.search(r'(?m)^# LibraMail 0\.6\.4 - ', changelog[past.start():]):
        raise ValueError('Plusieurs entrées 0.6.4 détectées : inspecter le CHANGELOG.')
    new_changelog = f'# LibraMail {VERSION} - {date}\n\n{FR.strip()}\n\n{EN.strip()}\n\n---\n\n' + changelog[past.start():]

    publish_path = ROOT / 'docs/PUBLISHING.md'
    publish = publish_path.read_text(encoding='utf-8')
    cutoff = re.search(r'(?m)^## macOS experimental build \(0\.6\.3\+\)\s*$', publish)
    if not cutoff:
        cutoff = re.search(r'(?m)^## macOS experimental packages \(0\.6\.3\+\)\s*$', publish)
    if not cutoff:
        raise ValueError('Documentation macOS de publication inattendue. Arrêt sans écrasement.')
    new_publish = publish[:cutoff.start()].rstrip() + '\n\n' + PUBLISHING_SECTION
    for a, b in (
        ('python3 tools/set_version.py 0.6.3', 'python3 tools/set_version.py 0.6.4'),
        ('./github.sh notes 0.6.3', './github.sh notes 0.6.4'),
        ('./github.sh release 0.6.3', './github.sh release 0.6.4'),
        ('Prepare LibraMail 0.6.3', 'Prepare LibraMail 0.6.4'),
        ('Préparer LibraMail 0.6.3', 'Préparer LibraMail 0.6.4'),
    ):
        new_publish = replace_exact(new_publish, a, b)

    release_script = ROOT / 'release.sh'
    release_text = release_script.read_text(encoding='utf-8')
    release_text = replace_exact(release_text, './release.sh 0.6.3', './release.sh 0.6.4')

    # Tous les contrôles de structure ont été effectués avant les écritures.
    changelog_path.write_text(new_changelog, encoding='utf-8')
    publish_path.write_text(new_publish, encoding='utf-8')
    release_script.write_text(release_text, encoding='utf-8')
    run(sys.executable, 'tools/set_version.py', VERSION)
    run(sys.executable, 'tools/generate_release_notes.py', VERSION)
    notes = (ROOT / '.github/release-notes.md').read_text(encoding='utf-8')
    (ROOT / 'NOTES_0.6.4.md').write_text(notes, encoding='utf-8')

    readme_path = ROOT / 'README.md'
    readme = readme_path.read_text(encoding='utf-8')
    for a, b in (
        ('./github.sh notes 0.6.3', './github.sh notes 0.6.4'),
        ('./github.sh release 0.6.3', './github.sh release 0.6.4'),
    ):
        readme = replace_exact(readme, a, b)
    readme_path.write_text(readme, encoding='utf-8')

    run(sys.executable, 'tools/check_version.py')
    run(sys.executable, 'tools/generate_release_notes.py', '--check')
    print(f'[OK] LibraMail {VERSION} : version et documentation FR/EN synchronisées ({date}).')
    print('[INFO] Aucun tag ni publication GitHub n’a été créé.')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', default='2026-11-10', help='Date de release YYYY-MM-DD (défaut : 2026-11-10)')
    args = parser.parse_args()
    try:
        prepare(args.date)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f'[ERREUR] Préparation 0.6.4 : {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
