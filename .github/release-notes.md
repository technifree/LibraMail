# LibraMail 0.4.6

## Français

LibraMail 0.4.6 est une version corrective consacrée à la cohérence des vues, à la sélection multiple, à l’export EML et à la réactivité de l’interface.

### Suppression et compteurs

- Les suppressions simples et multiples réconcilient maintenant immédiatement la liste affichée et les compteurs.
- Les caches sont invalidés afin d’éviter le retour temporaire d’un ancien état après suppression.
- La sélection multiple est remise à zéro après l’opération.
- La suppression d’un dossier local conserve les messages : seul le classement local est supprimé.

### Windows

- `data/engine-startup.log` conserve désormais l’historique des sessions au lieu d’être réinitialisé à chaque lancement.
- Le journal reste borné pour éviter une croissance indéfinie.
- L’arrêt du moteur embarqué est renforcé.
- Un arrêt de secours peut être utilisé uniquement sur le PID du moteur `node.exe` lancé par LibraMail ; aucun arrêt global de processus Node n’est effectué.

### Sélection multiple

- `Ctrl+A` sélectionne tous les messages de la vue courante.
- Le raccourci garde son comportement normal dans les champs de saisie, la recherche, les zones éditables et les fenêtres modales.
- Le bouton « Tout sélectionner » est placé plus visiblement au-dessus de la liste.

### Export EML multiple

- Les messages sélectionnés peuvent être exportés en une seule opération.
- Le dossier de destination est choisi une seule fois.
- Les conversations sélectionnées exportent les messages qu’elles contiennent.
- Le MIME brut est conservé sans reconstruction.
- Les fichiers existants ne sont jamais écrasés : LibraMail génère automatiquement un nom disponible.

### Réactivité

- Réduction des rafraîchissements complets lors des modifications d’étiquettes.
- Mise à jour ciblée des vues réellement concernées.
- Les actions multiples « lu/non lu » et « favori » sont appliquées directement dans la liste.
- Certains rafraîchissements de compteurs sont regroupés afin de limiter les opérations inutiles.

---

## English

LibraMail 0.4.6 is a corrective release focused on view consistency, multiple selection, EML export, and interface responsiveness.

### Deletion and counters

- Single and multiple message deletions now immediately reconcile the visible list and counters.
- Caches are invalidated to prevent stale states from briefly reappearing after deletion.
- Multiple selection is cleared after the operation.
- Deleting a local folder keeps the messages: only the local filing assignment is removed.

### Windows

- `data/engine-startup.log` now keeps previous session history instead of being reset on every launch.
- The log remains size-bounded.
- Bundled engine shutdown is more robust.
- A fallback shutdown may target only the PID of the `node.exe` engine started by LibraMail; no global Node process termination is used.

### Multiple selection

- `Ctrl+A` now selects all messages in the current view.
- Native select-all behavior is preserved in input fields, search, editable areas, and modal dialogs.
- The Select all control is positioned more visibly above the message list.

### Multiple EML export

- Selected messages can be exported in a single operation.
- The destination folder is selected once for the whole batch.
- Selected conversations export the messages they contain.
- Raw MIME is preserved without rebuilding messages.
- Existing files are never overwritten: LibraMail automatically generates an available filename.

### Responsiveness

- Full list refreshes are reduced when labels are added or removed.
- Only views whose contents actually change are reconciled.
- Bulk read/unread and favorite actions are patched directly into the visible list.
- Some counter refreshes are grouped to avoid unnecessary work.
