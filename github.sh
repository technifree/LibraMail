#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"

usage() {
  cat <<'EOF'
LibraMail — gestion GitHub

  ./github.sh check
      Contrôle la version, les sources et les exclusions de sécurité.

  ./github.sh init [public|private]
      Crée/configure le dépôt GitHub et pousse les sources.
      Valeur par défaut : technifree/LibraMail, branche master, public.

  ./github.sh build
      Compile Linux et Windows sur GitHub Actions et télécharge les artefacts.

  ./github.sh release X.Y.Z ["Notes FR"] ["Notes EN"]
      Met à jour la version, pousse le tag et publie les deux paquets.

  ./github.sh status
      Affiche l'état Git, les derniers workflows et les publications.
EOF
}

cmd="${1:-}"
case "$cmd" in
  check)
    ./security_check.sh
    python3 tools/check_version.py
    node_files=()
    while IFS= read -r -d '' file; do node_files+=("$file"); done < <(
      find engine resources/js -type f -name '*.js' -print0 2>/dev/null
    )
    if command -v node >/dev/null 2>&1; then
      for file in "${node_files[@]}"; do node --check "$file" >/dev/null; done
      echo "[JAVASCRIPT] OK : ${#node_files[@]} fichier(s)"
    else
      echo "[JAVASCRIPT] Node absent localement : contrôle laissé à GitHub Actions."
    fi
    python3 - <<'PY'
import json
from pathlib import Path
files = [Path("neutralino.config.json")]
files += sorted(Path("resources/locales").glob("*.json"))
for path in files:
    json.loads(path.read_text(encoding="utf-8"))
print(f"[JSON] OK : {len(files)} fichier(s)")
PY
    ;;
  init)
    [[ $# -le 2 ]] || { usage >&2; exit 2; }
    [[ $# -lt 2 ]] || export VISIBILITY="$2"
    exec ./setup_github.sh
    ;;
  build)
    exec ./build_github.sh
    ;;
  release)
    shift
    exec ./release.sh "$@"
    ;;
  status)
    git status --short --branch
    echo
    if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
      gh run list --limit 10
      echo
      gh release list --limit 10
    fi
    ;;
  -h|--help|help|"")
    usage
    ;;
  *)
    echo "Commande inconnue : $cmd" >&2
    usage >&2
    exit 2
    ;;
esac
