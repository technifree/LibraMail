#!/usr/bin/env bash
# ============================================================
# LibraMail — Lancement
# Démarre le moteur mail (Node) puis l'interface (Neutralino).
# À la fermeture de la fenêtre, le moteur est arrêté proprement.
# ============================================================
export WEBKIT_DISABLE_DMABUF_RENDERER=1
cd "$(dirname "$0")"

NODE_BIN="./bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN="node"

port_is_open() {
  (exec 3<>/dev/tcp/127.0.0.1/47800) >/dev/null 2>&1
}

if port_is_open; then
  echo "LibraMail est déjà en cours d'exécution (port 47800 occupé)." >&2
  exit 1
fi

"$NODE_BIN" engine/backend.js &
ENGINE_PID=$!
trap 'kill $ENGINE_PID 2>/dev/null || true' EXIT

# Attendre réellement le moteur au lieu de supposer qu'il sera prêt en 600 ms.
for _ in $(seq 1 100); do
  port_is_open && break
  if ! kill -0 "$ENGINE_PID" >/dev/null 2>&1; then
    wait "$ENGINE_PID" || true
    echo "Le moteur LibraMail n'a pas pu démarrer." >&2
    exit 1
  fi
  sleep 0.1
done

if ! port_is_open; then
  echo "Délai dépassé pendant le démarrage du moteur LibraMail." >&2
  exit 1
fi

if [ -x "./bin/libramail-linux_x64" ]; then
  ./bin/libramail-linux_x64 --load-dir-res --path=. --neu-dev-extension
else
  npx --yes @neutralinojs/neu@latest run
fi
