'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const build = fs.readFileSync(path.join(root, 'build_deb.sh'), 'utf8');
const desktop = fs.readFileSync(
  path.join(root, 'packaging/linux/libramail.desktop'),
  'utf8'
);
const buildLinux = fs.readFileSync(path.join(root, 'build_linux.sh'), 'utf8');

assert(buildLinux.includes("--exclude '*.old'"));
assert(buildLinux.includes("--exclude '*.bak'"));
assert(buildLinux.includes("--exclude '*.orig'"));
assert(buildLinux.includes('Le paquet portable contient encore un fichier .old/.bak/.orig.'));

assert(build.includes('PORTABLE_DIR="$PROJECT_DIR/build/linux/$PORTABLE_NAME"'));
assert(build.includes('SKIP_PORTABLE_BUILD=0'));
assert(build.includes('"$PROJECT_DIR/build_linux.sh"'));
assert(build.includes('APP_DIR="/opt/libramail"'));
assert(build.includes('STATE_ROOT="${XDG_DATA_HOME%/}/libramail"'));
assert(build.includes('${HOME:?HOME non défini}/.local/share/libramail'));
assert(build.includes('export LIBRAMAIL_STATE_ROOT="$STATE_ROOT"'));
assert(build.includes('LOG_FILE="$DATA_DIR/engine.log"'));
assert(build.includes('rm -rf -- "$OPT_DIR/data"'));
assert(build.includes('Depends: libwebkit2gtk-4.1-0, libstdc++6, libgcc-s1, xdg-utils'));
assert(build.includes('Recommends: zenity | yad | kdialog'));
assert(build.includes("find \"$PKG_ROOT\" -type f -exec chmod 0644 {} +"));
assert(build.includes("find \"$OPT_DIR/engine\" -type f"));
assert(build.includes("Le paquet Debian contient encore un fichier .old/.bak/.orig."));
assert(build.includes('dpkg-deb --root-owner-group --build'));
assert(build.includes('libramail_${VERSION}_${DEB_ARCH}.deb'));
assert(build.includes('sha256sum "$(basename "$DEB_FILE")"'));
assert(build.includes('CONTENTS_FILE="$WORK_DIR/deb-contents.txt"'));
assert(build.includes('dpkg-deb --contents "$DEB_FILE" > "$CONTENTS_FILE"'));
assert(!build.includes('dpkg-deb --contents "$DEB_FILE" | grep'));

assert(desktop.includes('Name=LibraMail'));
assert(desktop.includes('Exec=libramail'));
assert(desktop.includes('TryExec=/usr/bin/libramail'));
assert(desktop.includes('Icon=libramail'));
assert(desktop.includes('Terminal=false'));
assert(desktop.includes('Categories=Network;Email;Office;'));

console.log('[LibraMail] Tests packaging Debian 0.4.8 : OK');
