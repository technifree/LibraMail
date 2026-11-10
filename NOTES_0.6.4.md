# LibraMail 0.6.4 — 2026-11-10

## Français

### Correction des pièces jointes

- L'ajout d'une ou plusieurs pièces jointes à un nouveau message utilise désormais le répertoire de données réel de LibraMail, y compris avec une installation Debian.
- Le transfert d'un message reprend automatiquement ses pièces jointes depuis le contenu MIME d'origine, sans imposer de les ajouter à nouveau.
- Il est possible de retirer une pièce jointe depuis la fenêtre de rédaction avant l'envoi.

### Sécurisation des envois

- L'envoi, l'enregistrement d'un brouillon et la programmation d'un envoi différé attendent la préparation des fichiers joints.
- Lorsqu'une pièce jointe est manquante ou inaccessible, l'envoi SMTP est bloqué au lieu d'expédier silencieusement un message incomplet.
- Les copies temporaires gérées par LibraMail sont nettoyées lorsqu'elles ne sont plus nécessaires.

### Vérifications

- Tests de non-régression couvrant plusieurs pièces jointes, le transfert MIME et l'intégrité binaire d'un PDF et d'une image.

### Téléchargements

- Linux x86_64 : archive portable et paquet Debian (`.deb`)
- Windows x86_64 : archive portable
- macOS Intel x86_64 et Apple Silicon arm64 : paquets ZIP **EXPÉRIMENTAUX** (non signés, non notarisés, sans validation graphique sur Mac physique)
- Empreintes SHA-256 pour vérifier les téléchargements

Les paquets publics ne contiennent aucun compte, mot de passe ou message.

## English

### Attachment fixes

- Adding one or more attachments to a new message now uses LibraMail's actual writable data directory, including Debian installations.
- Forwarding a message automatically carries over its attachments from the original MIME message; recipients no longer receive a forward without the original files.
- Attachments can now be removed from the compose window before sending.

### Safer sending

- Sending, saving a draft and scheduling a message wait until attachment preparation has completed.
- If an attachment is missing or unreadable, SMTP sending is blocked instead of silently delivering an incomplete message.
- Temporary copies managed by LibraMail are cleaned up when no longer needed.

### Verification

- Regression tests cover multiple attachments, MIME forwarding and byte-for-byte integrity of PDF and image files.

### Downloads

- Linux x86_64 portable archive and Debian package (`.deb`)
- Windows x86_64 portable archive
- macOS Intel x86_64 and Apple Silicon arm64: **EXPERIMENTAL** ZIP packages (unsigned, not notarized, no physical-Mac GUI validation)
- SHA-256 checksums for download verification

Public packages contain no account, password or message data.
