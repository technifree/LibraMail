# LibraMail 0.6.3 — 2026-11-06

## Français

### Correction de lecture

- Le **délai de 0 seconde** marque le message comme lu et actualise aussi le compteur de la conversation, y compris lorsque celle-ci ne contient qu’un seul courriel.
- Les listes de messages mémorisées sont invalidées après un changement de lecture pour éviter de réafficher un ancien point vert au retour dans la boîte unifiée.
- Nouveau test de non-régression de lecture simple et des conversations à plusieurs messages.

### Notification des nouvelles versions

- Indicateur discret dans la barre supérieure lorsqu'une nouvelle version est publiée sur GitHub.
- Un clic sur cet indicateur ou sur « Nouvelle version disponible » dans « À propos » ouvre directement la page de téléchargement de la Release concernée, dans le navigateur par défaut.
- Le statut « LibraMail est à jour » dans « À propos » ouvre également la liste des téléchargements officiels, même lorsqu'aucune mise à jour n'est disponible.
- Contrôle automatique silencieux au démarrage et toutes les six heures lorsque LibraMail reste ouvert, avec vérification du numéro de version et d'une URL GitHub officielle.

### Préparation macOS (préversion)

- Ajout d’un script de construction macOS destiné à Intel x86_64 et Apple Silicon arm64, avec Node.js et SQLite natifs, imapsync obligatoire et données utilisateur enregistrées hors du paquet applicatif.
- Ajout d’un workflow GitHub Actions **manuel et expérimental** pour tester les deux architectures. Les paquets macOS ne sont pas encore intégrés à la publication officielle : compilation, signature et tests utilisateurs restent nécessaires.

## English

### Read-state fixes

- A **0-second read delay** now updates both the message and its conversation unread count, including single-message threads.
- Cached message lists are invalidated after read-state changes to prevent a stale unread dot when returning to the unified inbox.
- Added regression tests for single-message and multi-message conversations.

### Update notifications

- A discreet header indicator appears when a newer GitHub Release is available.
- Clicking the indicator or the “New version available” label in About opens that release's download page in the default browser.
- Clicking “LibraMail is up to date” in About also opens the official downloads list, even when no update is available.
- Silent checks run at startup and every six hours while the app stays open, using version validation and the official GitHub release URL.

### macOS build preparation (preview)

- Added an experimental macOS build script for Intel x86_64 and Apple Silicon arm64, with native Node.js and SQLite, mandatory imapsync and user data stored outside the application bundle.
- Added a **manual, experimental** GitHub Actions workflow for both architectures. macOS artifacts are not yet part of the official release; packaging, signing and real-world testing remain to be qualified.

### Downloads / Téléchargements

- Linux x86_64 portable package and Debian package (`.deb`)
- Windows x86_64 portable package
- SHA-256 checksums for verification

Public packages contain no account, password or message data.
Les paquets publics ne contiennent aucun compte, mot de passe ou message.
