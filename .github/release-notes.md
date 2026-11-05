# LibraMail 0.6.2 — 2026-11-04

## Français

### Réactivité et suppression

- Accélération de l'affichage des conversations grâce à un index SQLite dédié, y compris sur les bases existantes (créé automatiquement au démarrage).
- Une seule requête agrégée pour les compteurs de la barre latérale et des comptes, au lieu de relire plusieurs listes de messages.
- Suppressions par lots traitées avec trois groupes de dossiers au maximum en parallèle pour ne pas saturer les serveurs IMAP.
- Une fois le déplacement IMAP confirmé, la réponse de suppression ne reste plus bloquée par la relève du dossier Corbeille : celle-ci est différée, puis la vue est actualisée.
- Retour visuel pendant une suppression multiple ; réconciliation des lignes en cas d'erreur partielle.
- Propagation des changements de lecture d'une conversation par lots de UID, sans ouvrir une connexion IMAP par message.

### Marquage comme lu

- Le délai de lecture **0 seconde** marque le message comme lu dès son ouverture effective dans le lecteur.
- L'ouverture d'une conversation marque tous ses messages comme lus si l'option est activée, même si le dernier message était déjà lu.
- Une modification du délai ou de l'activation du marquage automatique est immédiatement réappliquée au message déjà affiché.

### Vérifications

- Ajout de tests SQLite des compteurs/index et de tests du marquage immédiat, différé et désactivé.
- Les tests automatisés ne se substituent pas à une validation IMAP en conditions réelles auprès de différents fournisseurs.

## English

### Responsiveness and deletion

- Faster conversation display thanks to a dedicated SQLite index, automatically created for existing databases at startup.
- Sidebar and account counters are now calculated with one aggregated query instead of loading several message lists.
- Bulk deletions process up to three folder groups concurrently to avoid overwhelming IMAP servers.
- Once an IMAP move is confirmed, deletion no longer waits for the Trash folder to synchronize. That refresh takes place later, followed by a view update.
- Better visual feedback during bulk deletion, with list reconciliation after a partial failure.
- Read-state updates in a conversation use batches of UIDs instead of opening an IMAP connection per message.

### Mark as read

- A **0-second** delay marks a message as read immediately when it is effectively opened in the reader.
- Opening a conversation marks all its messages as read when the option is enabled, even if the newest message was already read.
- Changing the read delay or the automatic-read setting takes effect immediately on the message currently displayed.

### Verification

- Added SQLite counter/index tests and coverage for immediate, delayed and disabled read marking.
- Automated tests do not replace real-world IMAP checks with different providers.

### Downloads / Téléchargements

- Linux x86_64 portable package and Debian package (`.deb`)
- Windows x86_64 portable package
- SHA-256 checksums for verification

Public packages contain no account, password or message data.
Les paquets publics ne contiennent aucun compte, mot de passe ou message.
