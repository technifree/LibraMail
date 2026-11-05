#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"
# Alias de compatibilité : la mise à jour du README produit également
# les notes de publication, à partir d'une seule source : CHANGELOG.md.
exec python3 tools/generate_release_notes.py "$(cat VERSION)"
