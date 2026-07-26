#!/usr/bin/env bash
set -Eeuo pipefail

PATCH_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(pwd)"
FILES_DIR="$PATCH_DIR/files"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$PROJECT_DIR/.logo-theme-backup-$STAMP"

required=(
  "resources/index.html"
  "resources/css/app.css"
  "resources/themes/dark.css"
  "resources/themes/light.css"
)

for file in "${required[@]}"; do
  if [[ ! -f "$PROJECT_DIR/$file" ]]; then
    echo "[ERREUR] Fichier absent : $PROJECT_DIR/$file" >&2
    exit 1
  fi
done

mkdir -p \
  "$BACKUP_DIR/resources/css" \
  "$BACKUP_DIR/resources/themes" \
  "$BACKUP_DIR/resources/js" \
  "$BACKUP_DIR/resources/locales"

cp -a "$PROJECT_DIR/resources/index.html" "$BACKUP_DIR/resources/index.html"
cp -a "$PROJECT_DIR/resources/css/app.css" "$BACKUP_DIR/resources/css/app.css"
cp -a "$PROJECT_DIR/resources/themes/dark.css" "$BACKUP_DIR/resources/themes/dark.css"
cp -a "$PROJECT_DIR/resources/themes/light.css" "$BACKUP_DIR/resources/themes/light.css"

[[ -f "$PROJECT_DIR/resources/js/app.js" ]] \
  && cp -a "$PROJECT_DIR/resources/js/app.js" "$BACKUP_DIR/resources/js/app.js"

[[ -f "$PROJECT_DIR/resources/locales/fr.json" ]] \
  && cp -a "$PROJECT_DIR/resources/locales/fr.json" "$BACKUP_DIR/resources/locales/fr.json"

[[ -f "$PROJECT_DIR/resources/locales/en.json" ]] \
  && cp -a "$PROJECT_DIR/resources/locales/en.json" "$BACKUP_DIR/resources/locales/en.json"

if [[ -f "$PROJECT_DIR/data/config.json" ]]; then
  mkdir -p "$BACKUP_DIR/data"
  cp -a "$PROJECT_DIR/data/config.json" "$BACKUP_DIR/data/config.json"
fi

mkdir -p "$PROJECT_DIR/resources/assets"

cp -a "$FILES_DIR/resources/index.html" "$PROJECT_DIR/resources/index.html"
cp -a "$FILES_DIR/resources/css/app.css" "$PROJECT_DIR/resources/css/app.css"
cp -a "$FILES_DIR/resources/themes/dark.css" "$PROJECT_DIR/resources/themes/dark.css"
cp -a "$FILES_DIR/resources/themes/light.css" "$PROJECT_DIR/resources/themes/light.css"
cp -a "$FILES_DIR/resources/assets/logo-light.png" "$PROJECT_DIR/resources/assets/logo-light.png"
cp -a "$FILES_DIR/resources/assets/logo-dark.png" "$PROJECT_DIR/resources/assets/logo-dark.png"

python3 - "$PROJECT_DIR" <<'PYCODE'
from pathlib import Path
import json
import re
import sys

root = Path(sys.argv[1])

app = root / "resources/js/app.js"
if app.exists():
    text = app.read_text(encoding="utf-8")

    text, defaults_count = re.subn(
        r"const DEFAULT_ACCENTS = \{ dark: '#D4A94F', light: '#A8801F' \};",
        "const DEFAULT_ACCENTS = { dark: '#A879DA', light: '#4782D6' };",
        text,
        count=1,
    )

    text, preset_count = re.subn(
        r"\{ id: 'libra', color: '#D4A94F' \}",
        "{ id: 'libra', color: '#A879DA' }",
        text,
        count=1,
    )

    if defaults_count != 1 or preset_count != 1:
        raise SystemExit(
            "[ERREUR] Les constantes de couleur attendues sont introuvables "
            "dans resources/js/app.js."
        )

    app.write_text(text, encoding="utf-8")

translations = [
    ("resources/locales/fr.json", "Or LibraMail", "Violet LibraMail"),
    ("resources/locales/en.json", "LibraMail gold", "LibraMail violet"),
]

for relative, old, new in translations:
    path = root / relative
    if not path.exists():
        continue
    text = path.read_text(encoding="utf-8")
    if old in text:
        path.write_text(text.replace(old, new, 1), encoding="utf-8")

# Ne migre que les anciennes couleurs par défaut.
# Une vraie couleur personnalisée reste intacte.
config = root / "data/config.json"
if config.exists():
    try:
        data = json.loads(config.read_text(encoding="utf-8"))
        old_color = str(data.get("accentColor") or "").upper()

        if old_color in {"#D4A94F", "#A8801F"}:
            data["accentColor"] = (
                "#4782D6" if data.get("theme") == "light" else "#A879DA"
            )
            config.write_text(
                json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            print("[INFO] Ancienne couleur par défaut migrée.")
    except Exception as exc:
        print(f"[WARN] data/config.json non modifié : {exc}")
PYCODE

echo "[OK] Logos et thèmes adaptés à la version actuelle de LibraMail."
echo "[INFO] Sauvegarde créée dans : $BACKUP_DIR"
