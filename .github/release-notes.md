# LibraMail 0.5.0

## Français

LibraMail 0.5.0 apporte un planning plus complet, un résumé de la journée au démarrage, plusieurs améliorations de stabilité et un durcissement important de la communication locale entre l’interface et le moteur.

### Sécurité

- L’API WebSocket locale du moteur nécessite désormais une authentification de session.
- Le jeton est aléatoire, éphémère et renouvelé à chaque démarrage.
- Les connexions provenant d’origines Web externes sont refusées.
- L’accès reste limité au loopback local et les requêtes WebSocket sont bornées en taille.
- Le jeton de session n’est pas inclus dans les données utilisateur ni dans les sauvegardes LibraMail.
- Le fonctionnement du mot de passe principal et du verrouillage a également été affiné.

### Planning

- Catégories de rendez-vous avec couleurs et icônes personnalisables.
- Pièces jointes sur les rendez-vous.
- Indicateur de pièce jointe dans les vues du planning.
- Les pièces jointes du planning sont intégrées à la sauvegarde/restauration complète.

### Résumé de la journée

- Nouveau résumé au démarrage avec messages non lus, rendez-vous du jour et état de synchronisation.
- Mise à jour en direct pendant la relève.
- Affichage désactivable depuis le résumé ou les paramètres.

### Courrier et interface

- Améliorations de stabilité de la relève IMAP.
- Indicateur de chargement plus visible.
- Sélection globale de toute la vue courante.
- Amélioration du classement depuis la corbeille vers les dossiers locaux.
- Nettoyage du transport SMTP.
- Paramètres réorganisés en sections et nouvelle section dédiée aux indésirables.

### Paquets

- Linux x86_64 : archives portables ZIP / tar.gz et paquet Debian amd64.
- Windows x86_64 : archive portable ZIP.
- Sommes SHA-256 fournies avec les paquets publiés.

---

## English

LibraMail 0.5.0 adds a more capable planner, a startup day summary, several mail-stability improvements, and significant hardening of the local communication channel between the UI and the mail engine.

### Security

- The engine’s local WebSocket API now requires per-session authentication.
- The token is random, ephemeral, and renewed on every engine start.
- Connections from external web origins are rejected.
- Access remains restricted to the local loopback interface and WebSocket request size is bounded.
- The session token is not included in user data or LibraMail backups.
- Master-password and application-lock behaviour has also been refined.

### Planner

- Appointment categories with customizable colors and icons.
- Attachments on planner events.
- Attachment indicators across planner views.
- Planner attachments are included in complete backup/restore operations.

### Startup day summary

- New startup summary showing unread mail, today’s appointments, and synchronization status.
- Live updates while accounts are being synchronized.
- The summary can be disabled directly or from Settings.

### Mail and interface

- Improved IMAP synchronization stability.
- Clearer loading indication.
- Select-all now applies to the complete current view.
- Improved classification from Trash to local folders.
- SMTP transport cleanup.
- Settings reorganized into dedicated sections, including a new Junk settings section.

### Packages

- Linux x86_64: portable ZIP / tar.gz archives and Debian amd64 package.
- Windows x86_64: portable ZIP archive.
- SHA-256 checksums are published alongside the packages.
