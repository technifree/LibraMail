#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def fail(message: str) -> None:
    print(f"[VERSION] ERREUR : {message}", file=sys.stderr)
    raise SystemExit(1)

config_path = ROOT / "neutralino.config.json"
if not config_path.exists():
    fail("neutralino.config.json est absent.")

config = json.loads(config_path.read_text(encoding="utf-8"))
version = str(config.get("version", "")).strip()
if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", version):
    fail(f"version Neutralino invalide : {version!r}")

checks = {
    "VERSION": ROOT / "VERSION",
    "README.md": ROOT / "README.md",
    "resources/index.html": ROOT / "resources/index.html",
    "engine/backend.js": ROOT / "engine/backend.js",
}

missing = [name for name, path in checks.items() if not path.exists()]
if missing:
    fail("fichiers absents : " + ", ".join(missing))

if checks["VERSION"].read_text(encoding="utf-8").strip() != version:
    fail("VERSION ne correspond pas à neutralino.config.json.")

readme = checks["README.md"].read_text(encoding="utf-8")
if f"version-{version}-" not in readme:
    fail("le badge de version du README n'est pas synchronisé.")

html = checks["resources/index.html"].read_text(encoding="utf-8")
if version not in html:
    fail("resources/index.html ne contient pas la version courante.")

backend = checks["engine/backend.js"].read_text(encoding="utf-8")
backend_patterns = [
    rf"APP_VERSION\s*=\s*['\"]{re.escape(version)}['\"]",
    rf"version\s*:\s*['\"]{re.escape(version)}['\"]",
]
if not any(re.search(pattern, backend) for pattern in backend_patterns):
    fail("engine/backend.js ne contient pas une constante de version reconnue.")

print(f"[VERSION] OK : {version}")
