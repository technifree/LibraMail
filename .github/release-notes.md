# LibraMail 0.6.3 — 2026-11-08

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

### Distribution macOS expérimentale

- Deux archives macOS expérimentales, pour Intel x86_64 et Apple Silicon arm64, rejoignent les téléchargements GitHub, avec Node.js, SQLite et imapsync embarqués et les données utilisateur conservées hors de l’application.
- Les compilations macOS Intel et Apple Silicon ont été validées dans GitHub Actions, avec des tests automatisés du paquet, de SQLite, du moteur Node.js et d’imapsync.
- Les archives macOS sont intégrées à la publication GitHub sous l’intitulé **expérimental** : elles restent non signées, non notarisées et non testées graphiquement sur un Mac physique. Un échec sur une architecture bloque la publication complète.

### Téléchargements

- Linux x86_64 : archive portable et paquet Debian (`.deb`)
- Windows x86_64 : archive portable
- macOS Intel x86_64 et Apple Silicon arm64 : paquets ZIP **EXPÉRIMENTAUX** (non signés, non notarisés, sans validation graphique sur Mac physique)
- Empreintes SHA-256 pour vérifier les téléchargements

Les paquets publics ne contiennent aucun compte, mot de passe ou message.

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

### Experimental macOS distribution

- Two experimental macOS packages for Intel x86_64 and Apple Silicon arm64 are now included in GitHub downloads, with bundled Node.js, SQLite and imapsync and user data stored outside the application bundle.
- Both macOS architectures now pass CI builds and automated smoke tests of the app package, native SQLite, Node.js engine and imapsync.
- macOS archives are included in the GitHub release as clearly labeled **experimental** assets: they remain unsigned, unnotarized and not visually tested on physical Macs. A failing architecture blocks the complete release.

### Downloads

- Linux x86_64 portable archive and Debian package (`.deb`)
- Windows x86_64 portable archive
- macOS Intel x86_64 and Apple Silicon arm64: **EXPERIMENTAL** ZIP packages (unsigned, not notarized, no physical-Mac GUI validation)
- SHA-256 checksums for download verification

Public packages contain no account, password or message data.
