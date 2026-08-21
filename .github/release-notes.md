# LibraMail 0.4.3

## Français

LibraMail 0.4.3 est une version corrective qui rétablit le glisser-déposer des pièces jointes dans la fenêtre de rédaction.

### Corrections

- Correction du glisser-déposer des fichiers dans un nouveau message ou une réponse.
- Les fichiers déposés sont désormais ajoutés comme véritables pièces jointes.
- Un fichier PDF déposé n'est plus ouvert directement dans LibraMail.
- Les chemins locaux `file://` ne sont plus insérés dans le corps du message.
- Prise en charge des fichiers PDF, ZIP, images, documents et autres types de fichiers.
- Prise en charge du dépôt simultané de plusieurs fichiers.

### Technique

- Mise à jour de Neutralino vers la version 6.8.0.
- Utilisation du mécanisme natif `filesDropped`.
- Activation de `emitDropEvents` afin que le WebView n'interprète plus directement les fichiers déposés.

---

## English

LibraMail 0.4.3 is a corrective release that restores drag-and-drop attachment handling in the message composer.

### Fixes

- Fixed file drag-and-drop in new messages and replies.
- Dropped files are now added as real email attachments.
- Dropping a PDF no longer opens it directly inside LibraMail.
- Local `file://` paths are no longer inserted into the message body.
- PDF, ZIP, image, document and other file types are supported.
- Multiple files can be dropped at once.

### Technical changes

- Neutralino updated to version 6.8.0.
- Native Neutralino `filesDropped` event is now used.
- `emitDropEvents` is enabled to prevent the WebView from handling dropped files directly.

---

## Downloads / Téléchargements

- Linux x86_64 portable package
- Windows x86_64 portable package
- SHA-256 checksums

Public packages contain no account, password or message data.  
Les paquets publics ne contiennent aucun compte, mot de passe ou message.
