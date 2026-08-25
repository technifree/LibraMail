# LibraMail 0.4.5

## Français

LibraMail 0.4.5 est une version corrective centrée sur la robustesse sous Windows et les échanges de messages au format EML.

### Démarrage Windows

- Le délai d’attente du moteur embarqué passe de 12 à 30 secondes.
- Une dernière vérification est effectuée avant de considérer le démarrage comme échoué.
- Si le moteur ne répond réellement pas, LibraMail tente maintenant d’arrêter proprement le `node.exe` lancé afin d’éviter qu’un processus reste en arrière-plan.
- Le journal `data/engine-startup.log` est plus exploitable sous Windows.

### Import EML

- Les erreurs d’import sont maintenant détaillées par étape.
- Un rapport `data/eml-import.log` est généré après chaque import.
- La première erreur est affichée directement dans l’interface.
- Les compteurs et les vues de dossiers locaux sont rafraîchis immédiatement après import.
- Les caches de navigation sont invalidés de façon plus stricte pour éviter l’affichage d’informations périmées.

### Export EML

Une nouvelle action **Exporter .eml** est disponible dans le lecteur de message.

L’export utilise directement le MIME brut conservé par LibraMail : le message n’est pas reconstruit. Les en-têtes, le `Message-ID`, le contenu texte/HTML et les pièces jointes sont ainsi préservés.

---

## English

LibraMail 0.4.5 is a corrective release focused on Windows robustness and EML message exchange.

### Windows startup

- The bundled engine startup timeout is increased from 12 to 30 seconds.
- A final probe is performed before startup is considered failed.
- On a real startup failure, LibraMail now attempts to stop the `node.exe` process it launched so that no orphaned engine remains in the background.
- `data/engine-startup.log` is easier to use for Windows diagnostics.

### EML import

- Import failures now include detailed processing-stage information.
- A `data/eml-import.log` report is generated after each import.
- The first import error is displayed directly in the interface.
- Local-folder counters and views are refreshed immediately after import.
- Navigation caches are invalidated more strictly to avoid stale views.

### EML export

A new **Export .eml** action is available in the message reader.

Export uses the raw MIME message stored by LibraMail without rebuilding it. Headers, `Message-ID`, text/HTML parts, and attachments are therefore preserved.
