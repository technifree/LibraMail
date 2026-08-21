# LibraMail 0.4.2

## Français

LibraMail 0.4.2 améliore en profondeur la gestion de la relève du courrier et ajoute l'import de messages au format EML.

### Import de messages EML

LibraMail peut désormais importer un ou plusieurs messages `.eml` provenant d'un autre logiciel de messagerie ou d'une archive existante.

- Sélection de plusieurs fichiers EML en une seule opération.
- Choix du compte de destination.
- Détection automatique des messages reçus ou envoyés.
- Possibilité de forcer le classement en messages reçus ou envoyés.
- Détection des doublons afin d'éviter les imports multiples d'un même message.
- Les messages importés peuvent être lus, supprimés, restaurés et gérés normalement dans LibraMail.
- Les messages importés sont stockés localement dans le magasin chiffré de LibraMail.
- Aucun message importé n'est envoyé vers le serveur IMAP ou POP3.

### Relève du courrier

Cette version apporte également plusieurs corrections importantes au moteur de relève :

- amélioration de l'arrêt d'une relève en cours ;
- correction des relèves pouvant continuer à fonctionner après une demande d'arrêt ;
- meilleure libération des connexions IMAP lors d'une interruption ;
- amélioration de la réactivité de l'application pendant les relèves ;
- réduction de l'impact d'une relève lente ou bloquée sur les autres opérations de LibraMail.

### Stockage et sécurité

Les messages EML importés restent entièrement locaux et sont isolés de la synchronisation IMAP.

Le stockage chiffré est utilisé pour conserver les messages importés et aucun fichier EML importé n'est conservé en clair dans le dossier de données de LibraMail.

---

## English

LibraMail 0.4.2 significantly improves mail retrieval handling and adds support for importing EML messages.

### EML message import

LibraMail can now import one or more `.eml` messages from another email client or an existing archive.

- Multiple EML files can be selected in a single operation.
- Destination account selection.
- Automatic detection of received and sent messages.
- Received or sent classification can also be selected manually.
- Duplicate detection prevents the same message from being imported multiple times.
- Imported messages can be read, deleted, restored and managed normally in LibraMail.
- Imported messages are stored locally in LibraMail's encrypted message store.
- No imported message is uploaded to the IMAP or POP3 server.

### Mail retrieval

This release also includes important improvements to the mail retrieval engine:

- improved cancellation of an active mail check;
- fixes for mail checks that could continue running after being stopped;
- improved IMAP connection cleanup when cancelling an operation;
- improved application responsiveness during mail retrieval;
- reduced impact of slow or stalled mail checks on other LibraMail operations.

### Storage and security

Imported EML messages remain entirely local and are isolated from IMAP synchronization.

Encrypted storage is used for imported messages and imported EML files are never retained unencrypted in LibraMail's data directory.

---

## Downloads / Téléchargements

- Linux x86_64 portable package
- Windows x86_64 portable package
- SHA-256 checksums

Public packages contain no account, password or message data.  
Les paquets publics ne contiennent aucun compte, mot de passe ou message.
