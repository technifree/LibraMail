# LibraMail 0.4.4

## Français

LibraMail 0.4.4 apporte une organisation locale plus complète des messages, une meilleure gestion des pièces jointes et une relève IMAP plus robuste.

### Dossiers locaux

Les dossiers locaux sont indépendants des comptes IMAP : un message peut être classé localement sans être déplacé sur le serveur.

- Dossiers et sous-dossiers de profondeur libre.
- Compteurs récursifs sur toute la branche.
- Classement des messages par glisser-déposer.
- Déplacement des dossiers eux-mêmes par glisser-déposer.
- Retour d'un dossier à la racine.
- Protection contre les cycles et les doublons entre dossiers frères.
- Même nom autorisé dans des branches différentes.
- Navigation accélérée grâce au cache et au préchargement des dossiers voisins.
- Sauvegarde/restauration de la hiérarchie et des affectations.

L'import EML peut désormais classer directement les nouveaux messages dans un dossier local. Les doublons détectés ne sont pas reclassés automatiquement.

### Pièces jointes et interface

- Ouverture directe des pièces jointes avec l'application associée du système.
- Action « Enregistrer sous » toujours disponible.
- Blocage de l'ouverture directe pour les extensions potentiellement dangereuses.
- Indicateur de pièce jointe toujours visible au survol de la liste.
- Affichage de l'année pour les anciens messages.
- Volet Planning rendu réellement responsive sur les fenêtres étroites.

### Relève IMAP

La synchronisation IMAP bénéficie maintenant de limites de temps par phase, d'une interruption contrôlée des connexions bloquées et d'une reconnexion automatique.

Les connexions IMAP IDLE persistantes récupèrent également proprement après des erreurs réseau telles que `ETIMEDOUT` ou `ECONNRESET`, sans remonter en erreur non interceptée.

---

## English

LibraMail 0.4.4 adds more complete local message organization, improved attachment handling, and more robust IMAP synchronization.

### Local folders

Local folders are independent from IMAP accounts: messages can be filed locally without moving them on the server.

- Unlimited nested local folders.
- Recursive counters across the whole branch.
- Drag-and-drop message filing.
- Drag-and-drop folder moves.
- Move folders back to root.
- Cycle prevention and sibling duplicate protection.
- Identical folder names allowed in different branches.
- Faster navigation using cache and nearby-folder prefetching.
- Backup and restore of the hierarchy and message assignments.

EML import can now file newly imported messages directly into a local folder. Detected duplicates are not automatically reclassified.

### Attachments and interface

- Open attachments directly with the operating system's associated application.
- “Save As” remains available.
- Direct opening is blocked for potentially dangerous extensions.
- Attachment indicator remains visible when hovering message rows.
- Older message dates now include the year.
- The Planning side pane is now properly responsive on narrow windows.

### IMAP synchronization

IMAP synchronization now includes per-phase time limits, controlled interruption of stalled connections, and automatic reconnection.

Persistent IMAP IDLE connections also recover cleanly from network errors such as `ETIMEDOUT` or `ECONNRESET` without surfacing as uncaught errors.
