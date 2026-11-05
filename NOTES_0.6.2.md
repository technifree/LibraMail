# LibraMail 0.6.2 — installation et validation

## Ce qui change

Cette version améliore les requêtes de conversations, les compteurs et le traitement des suppressions, tout en corrigeant le marquage automatique comme lu lorsque le délai vaut `0` seconde. Les modifications détaillées figurent dans `CHANGELOG.md`.

## Mise à jour depuis une installation existante

1. **Fermer complètement LibraMail** et vérifier que son moteur n'est plus actif.
2. **Sauvegarder l'ensemble du dossier `data/`**, ainsi que `backups/` si celui-ci est utilisé. Les identifiants protégés dans le trousseau système peuvent dépendre du poste : faire les essais sur le poste habituel.
3. Copier le contenu de l'archive de mise à jour à la **racine des sources** LibraMail existantes, en conservant la même arborescence (`engine/`, `resources/`, etc.). Ne **pas** remplacer ni effacer le dossier `data/`.
4. Relancer LibraMail normalement. Le nouvel index de conversations SQLite est créé automatiquement lors du premier démarrage. Ne pas interrompre cette opération sur une boîte volumineuse.
5. Dans les paramètres, activer le marquage automatique, sélectionner un délai de `0`, puis ouvrir un message non lu et une conversation contenant des messages non lus.
6. Tester une suppression multiple, le vidage des spams et plusieurs allers-retours entre les dossiers et la boîte unifiée.

## Archive Linux portable de test

L'archive Linux de test comprend Node.js, les dépendances du moteur et Neutralino. Elle est fournie **sans données personnelles** : aucun compte, mot de passe, courriel ni base de messages n'est inclus. Extraire dans un nouveau dossier et lancer `./start.sh` depuis un terminal (faire `chmod +x start.sh` si les droits n'ont pas été conservés). Ne pas fusionner automatiquement son dossier `data/` vide avec celui de l'installation utilisée au quotidien.

## Tests et limites

- 82 tests automatisés réussis, notamment les tests de la base SQLite et du marquage immédiat/différé.
- Sur une base SQLite synthétique de 5 000 messages, une liste de 200 conversations a été obtenue en 37 à 61 ms (trois exécutions, machine de test). Ce résultat n'est pas une garantie de performance chez l'utilisateur.
- La durée d'un déplacement IMAP reste dépendante de la réponse du serveur distant. La synchronisation du dossier Corbeille est désormais dissociée du temps de confirmation de suppression.
- Aucun test IMAP réel avec les comptes utilisateur ni test graphique complet sous Linux/Windows/macOS n'a été effectué ici.

**Important :** les archives de livraison excluent volontairement les données privées et les anciens répertoires de construction, afin d'éviter toute diffusion involontaire.
