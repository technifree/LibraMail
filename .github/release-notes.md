# LibraMail 0.4.7

## Français

LibraMail 0.4.7 améliore la réactivité de l’interface et rétablit un lecteur de messages en fenêtre dédiée avec gestion des onglets.

### Étiquettes

- Les étiquettes ajoutées ou retirées d’un message apparaissent immédiatement dans la liste.
- Lorsqu’une étiquette est appliquée à une discussion, les messages déjà dépliés sont mis à jour immédiatement.
- La ligne de discussion, les messages enfants et l’état courant de la conversation restent synchronisés.
- Un message individuel peut toujours être étiqueté sans modifier toute sa discussion.

### Suppression

- Les messages supprimés disparaissent immédiatement de la liste.
- La liste complète n’est plus reconstruite après chaque suppression.
- Les compteurs sont actualisés en arrière-plan.

### Lecteur modal

- Un simple clic conserve l’aperçu dans le volet principal.
- Un double-clic sur la ligne d’un message ouvre une fenêtre de lecture dédiée.
- Le double-clic fonctionne sur toute la zone non interactive de la ligne.
- Plusieurs messages peuvent être ouverts dans des onglets au sein de cette fenêtre.
- L’onglet « Aperçu » n’est pas affiché dans la modale afin d’éviter les doublons.
- Fermer le dernier onglet ferme la fenêtre de lecture et revient à l’aperçu principal.

---

## English

LibraMail 0.4.7 improves interface responsiveness and restores a dedicated modal message reader with tab support.

### Labels

- Labels added to or removed from a message are reflected immediately in the message list.
- When a label is applied to a conversation, already expanded messages are updated immediately.
- The conversation row, visible child messages, and current conversation state remain synchronized.
- Individual messages can still be labeled without affecting the whole conversation.

### Deletion

- Deleted messages disappear from the list immediately.
- The entire message list is no longer rebuilt after each deletion.
- Counters are refreshed in the background.

### Modal reader

- A single click keeps the normal preview behavior.
- Double-clicking a message row opens a dedicated modal reader.
- Double-click works across the non-interactive area of the entire row.
- Multiple messages can be opened in tabs inside the modal reader.
- The Preview tab is hidden in the modal to avoid displaying the same message twice.
- Closing the last tab closes the reader window and returns to the main preview.
