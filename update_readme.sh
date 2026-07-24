#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"

DATE_EN="$(LC_ALL=en_US.UTF-8 date +'%-d %B %Y' 2>/dev/null || date +'%d/%m/%Y')"
DATE_FR="$(LC_ALL=fr_FR.UTF-8 date +'%-d %B %Y' 2>/dev/null || date +'%d/%m/%Y')"

python3 - "$DATE_EN" "$DATE_FR" <<'PY'
from pathlib import Path
import re
import sys

path = Path("README.md")
text = path.read_text(encoding="utf-8")
line = f"_Last documentation update / Dernière mise à jour : {sys.argv[1]} / {sys.argv[2]}._"
text, count = re.subn(
    r"_Last documentation update / Dernière mise à jour\s*:[^\n]+_",
    line,
    text,
)
if count == 0:
    text = text.rstrip() + "\n\n" + line + "\n"
path.write_text(text, encoding="utf-8")
print(f"[README] {line}")
PY
