# LibraMail 0.5.1

## Français

LibraMail 0.5.1 est une version de durcissement centrée sur la sécurité du stockage local, la robustesse des abonnements Planning et la validation automatisée du projet.

### Sécurité et stockage local

- Le stockage des nouveaux messages échoue désormais de manière sûre si la clé de chiffrement n'est pas disponible : aucun nouveau fichier EML n'est écrit en clair.
- Les extraits de messages (`snippet`) n'ont plus de chemin de repli en clair lorsque le coffre est indisponible.
- Les fichiers SQLite locaux sensibles sont resserrés avec des permissions privées sous POSIX, y compris `index.db`, ses fichiers WAL/SHM et les bases du `mailstore`.
- Les écritures JSON persistantes importantes utilisent désormais une écriture atomique avec fichier temporaire, synchronisation et renommage.
- Les abonnements calendrier distants sont protégés contre les accès SSRF : validation des URL, DNS et redirections, avec blocage des destinations locales, privées ou réservées.

### OAuth2

- Ajout d'un socle générique OAuth2/XOAUTH2 pour les chemins IMAP et SMTP.
- Les jetons d'accès restent en mémoire et les jetons de rafraîchissement utilisent le stockage protégé de LibraMail.
- Cette version n'active pas de flux OAuth spécifique à Microsoft ou à un autre fournisseur : une inscription d'application propre au fournisseur reste nécessaire.

### Interface

- Les compteurs des groupes de messages distinguent désormais plus clairement le total des messages et le nombre de non-lus.

### Tests et intégration continue

- La suite complète des tests `tools/test_*.js` est découverte et exécutée automatiquement.
- Vérification systématique sous Linux et Windows avec le runtime Node.js 22.23.1 aligné sur celui de LibraMail.
- Les contrôles de syntaxe JavaScript, JSON, sécurité du dépôt et cohérence de version restent exécutés avant publication.

## English

LibraMail 0.5.1 is a hardening release focused on local-storage security, safer remote calendar subscriptions and stronger automated validation.

### Security and local storage

- New-message storage now fails securely when the encryption key is unavailable: no new EML file is written in plaintext.
- Message snippets no longer have a plaintext fallback when the secure store is unavailable.
- Sensitive local SQLite files use restrictive permissions on POSIX, including `index.db`, its WAL/SHM files and mailstore databases.
- Important persistent JSON files are now written atomically using a temporary file, synchronization and rename.
- Remote calendar subscriptions are hardened against SSRF through URL, DNS and redirect validation, with local, private and reserved destinations blocked.

### OAuth2

- Added a generic OAuth2/XOAUTH2 foundation for IMAP and SMTP authentication paths.
- Access tokens remain in memory and refresh tokens use LibraMail's protected credential storage.
- This release does not enable a Microsoft-specific or other provider-specific OAuth flow; provider-side application registration is still required.

### Interface

- Message-group counters now distinguish the total number of messages from unread messages more clearly.

### Tests and continuous integration

- The complete `tools/test_*.js` suite is automatically discovered and executed.
- Linux and Windows verification now use Node.js 22.23.1, aligned with LibraMail's bundled runtime.
- JavaScript syntax, JSON, repository-safety and version-consistency checks remain part of the release verification.

### Downloads / Téléchargements

- Linux x86_64 portable package
- Debian amd64 package
- Windows x86_64 portable package
- SHA-256 checksums

Public packages contain no account, password or message data.
Les paquets publics ne contiennent aucun compte, mot de passe ou message.
