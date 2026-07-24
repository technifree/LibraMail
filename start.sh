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

"$NODE_BIN" engine/backend.js &
ENGINE_PID=$!
trap 'kill $ENGINE_PID 2>/dev/null' EXIT

# petite attente que le moteur ouvre son port
sleep 0.6

if [ -x "./bin/libramail-linux_x64" ]; then
  ./bin/libramail-linux_x64 --load-dir-res --path=. --neu-dev-extension
else
  npx --yes @neutralinojs/neu@latest run
fi
