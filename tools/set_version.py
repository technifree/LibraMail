#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if len(sys.argv) != 2 or not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", sys.argv[1]):
    print("Usage : tools/set_version.py X.Y.Z", file=sys.stderr)
    raise SystemExit(2)

version = sys.argv[1]

config_path = ROOT / "neutralino.config.json"
config = json.loads(config_path.read_text(encoding="utf-8"))
config["version"] = version
config.setdefault("modes", {}).setdefault("window", {})["title"] = f"LibraMail {version}"
config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

(ROOT / "VERSION").write_text(version + "\n", encoding="utf-8")

def replace_file(path: Path, replacements: list[tuple[str, str]], required: bool = True) -> None:
    if not path.exists():
        if required:
            raise SystemExit(f"Fichier absent : {path.relative_to(ROOT)}")
        return
    text = path.read_text(encoding="utf-8")
    original = text
    for pattern, replacement in replacements:
        text = re.sub(pattern, replacement, text)
    if text == original and required:
        print(f"[VERSION] Aucune marque remplacée dans {path.relative_to(ROOT)}", file=sys.stderr)
    path.write_text(text, encoding="utf-8")

replace_file(ROOT / "README.md", [
    (r"version-[0-9A-Za-z.+-]+-4f8bd8", f"version-{version}-4f8bd8"),
])

replace_file(ROOT / "resources/index.html", [
    (r"(<title>\s*LibraMail\s+)[^<]+(</title>)", rf"\g<1>{version}\g<2>"),
    (r'(title=["\']LibraMail\s+)[^"\']+(["\'])', rf"\g<1>{version}\g<2>"),
    (r"(id=[\"']app-version[\"'][^>]*>\s*)v?[0-9A-Za-z.+-]+", rf"\g<1>v{version}"),
], required=False)

replace_file(ROOT / "engine/backend.js", [
    (r"(APP_VERSION\s*=\s*['\"])[^'\"]+(['\"])", rf"\g<1>{version}\g<2>"),
], required=False)

replace_file(ROOT / "resources/js/app.js", [
    (r"(APP_VERSION\s*=\s*['\"])[^'\"]+(['\"])", rf"\g<1>{version}\g<2>"),
    (r"(NL_APPVERSION\s*\|\|\s*['\"])[^'\"]+(['\"])", rf"\g<1>{version}\g<2>"),
], required=False)

print(f"[VERSION] LibraMail synchronisé sur {version}")
