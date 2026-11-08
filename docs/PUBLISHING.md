# Publishing LibraMail with GitHub Actions

> **English** · [Français](#publication-de-libramail-avec-github-actions)

## One-time setup

Install and authenticate the GitHub CLI:

```bash
gh auth login
```

From the root of the LibreMail source tree:

```bash
chmod +x github.sh *.sh
./github.sh check
./github.sh init
```

Default repository: `technifree/LibraMail` (branch `master`, public). On first setup,
these settings may be changed with `GITHUB_OWNER`, `REPO_NAME`, `VISIBILITY`.

## Prepare the release without publishing

1. Add the newest entry at the **top** of `CHANGELOG.md`, with this format:

   ```markdown
   # LibraMail X.Y.Z - YYYY-MM-DD

   ## Français

   ### Améliorations
   - Description précise des corrections et nouveautés.

   ## English

   ### Improvements
   - Accurate English description of the changes.
   ```

2. Update the local version and generate the bilingual README and release notes:

   ```bash
   python3 tools/set_version.py 0.6.3
   ./github.sh notes 0.6.3
   ./github.sh check
   ```

   `notes` updates `README.md` (both languages and latest-version links) and
   `.github/release-notes.md`. The generator **does not translate**: both languages
   must be present in the changelog. If one is missing, it fails before publication.

3. Review the changes and commit your tested sources and publication files:

   ```bash
   git diff -- README.md CHANGELOG.md .github/release-notes.md
   git status --short
   git add README.md CHANGELOG.md .github/release-notes.md VERSION
   # Also stage and commit your tested application source changes.
   git commit -m "Prepare LibraMail 0.6.3"
   ```

   `./github.sh check` validates documentation consistency and runs the tests.
   All personal data must remain outside Git.

## Publish a release

```bash
./github.sh release 0.6.3
```

`release` requires a clean Git working tree, the `master` branch and an authenticated `gh` session.
It validates bilingual changelog content *before* changing files, synchronizes
version markers and notes, executes the full local preflight, then creates the
commit (if necessary) and tag and pushes them. GitHub Actions builds Linux, Windows, and (starting with 0.6.3) both macOS
architectures, with mandatory macOS package smoke tests. Mac archives are
**experimental, unsigned and not notarized**, with "-experimental" in their
names. If either Mac build fails, the release is not published. The bilingual
notes identify the remaining real-Mac validation gap.

If the tag already exists, the script refuses to overwrite it. The GitHub page
is not changed by `notes` or `check`: it is changed only when `release` pushes
and the GitHub Actions workflow completes successfully.

## Build without publishing

```bash
./github.sh build
```

This triggers `.github/workflows/build.yml` and downloads both build artifacts
into `github-artifacts/`, without creating a release.

## Workflow guarantees

- `verify.yml`: version, source checks and tests
- `build.yml`: manual build for Linux and Windows (unchanged)
- `macos-preview.yml`: separate CI smoke tests on development-branch pushes
- `release.yml`: tag-triggered verification, bilingual release-note integrity,
  Linux, Windows and two macOS package builds (from 0.6.3), macOS smoke tests
  and GitHub Release publication; either macOS failure blocks the publication

Public builds never use `--with-data`. No account data, messages or credentials
should be included in any public artifact.

---

# Publication de LibraMail avec GitHub Actions

## Configuration initiale

Installer GitHub CLI et se connecter :

```bash
gh auth login
```

À la racine des sources de LibraMail :

```bash
chmod +x github.sh *.sh
./github.sh check
./github.sh init
```

Par défaut : dépôt `technifree/LibraMail`, branche `master`, visibilité publique.
La configuration initiale peut être adaptée avec les variables `GITHUB_OWNER`,
`REPO_NAME` et `VISIBILITY`.

## Préparer la mise à jour sans publier

1. Ajouter la nouvelle version **en tête** de `CHANGELOG.md` en respectant
   le format présenté plus haut, avec `## Français` et `## English`.
   Les deux textes doivent décrire réellement les modifications : aucune
   traduction automatique approximative n'est effectuée.

2. Actualiser les documents et contrôler la version :

   ```bash
   python3 tools/set_version.py 0.6.3
   ./github.sh notes 0.6.3
   ./github.sh check
   ```

   La commande `notes` régénère les rubriques « Dernière version » du README
   français et anglais, les liens vers la publication et les notes détaillées
   `.github/release-notes.md`. Elle ne publie rien sur GitHub.

3. Examiner les modifications puis créer un commit avec les sources testées :

   ```bash
   git diff -- README.md CHANGELOG.md .github/release-notes.md
   git status --short
   git add README.md CHANGELOG.md .github/release-notes.md VERSION
   # Ajouter également les fichiers applicatifs vérifiés.
   git commit -m "Préparer LibraMail 0.6.3"
   ```

   Le contrôle `check` bloque les notes obsolètes et vérifie la cohérence du
   README, le code et la sécurité. Ne jamais intégrer le dossier privé `data/`.

## Publier la version

```bash
./github.sh release 0.6.3
```

Le script refuse une branche autre que `master`, les modifications locales non validées et les tags existants.
Il contrôle le `CHANGELOG.md` bilingue avant de modifier la version, synchronise
les documents, lance les tests et pousse le commit et le tag vers GitHub.
GitHub Actions compile ensuite Linux, Windows et, dès la version 0.6.3,
macOS Intel et Apple Silicon. Les paquets Mac sont identifiés
« -experimental » : ils ne sont ni signés ni notarisés, et leurs interfaces
n'ont pas été testées sur des Mac physiques. Les tests automatisés macOS sont
obligatoires ; l'échec d'une architecture bloque toute la publication.
La Release inclut des notes bilingues et des empreintes SHA-256.

Une commande `notes` ou `check` n'a **aucun effet sur le site GitHub** : la page
ne change qu'après publication et succès du workflow.

## Compiler sans publier

```bash
./github.sh build
```

Les archives sont téléchargées dans `github-artifacts/` sans créer de nouvelle
publication GitHub.

## Sécurité

Les workflows publics n'utilisent jamais `--with-data`. Les données de comptes,
les mots de passe et les messages restent exclusivement sur les postes locaux.

---

## Correctif CI 0.6.2 — imapsync (Linux / Windows)

Les compilations GitHub Actions embarquent obligatoirement un moteur imapsync
fonctionnel. Une compilation incomplète (`--without-imapsync` ou
`-WithoutImapsync`) ne peut jamais être utilisée pour une publication officielle.

Le workflow prépare automatiquement la version amont **2.314** :

- **Linux** : archive `imapsync-2.314.tgz`, vérifiée avec le SHA-256 fixe
  `34e1715c6584889ff3bd9c0acc2fab254446282beda90c8e5a71a83b3a59dbca`,
  puis compilation autonome au moyen de PAR::Packer et de ses dépendances Perl.
- **Windows** : archive amont `imapsync_2.314.zip`, vérifiée avec une empreinte
  SHA-256 approuvée dans la variable GitHub Actions de dépôt
  `IMAPSYNC_WINDOWS_ZIP_SHA256`, puis copie de `imapsync.exe` dans le runtime.
  L'exécutable n'est jamais accepté si cette empreinte manque ou diffère.

### Configuration unique de la variable Windows

Depuis le poste de développement, télécharger l'archive officielle 2.314
à partir de <https://imapsync.lamiral.info/dist2/> et contrôler sa provenance.
Avec `gh` connecté, exécuter (Linux) :

```bash
curl --fail --location --retry 3 \
  https://imapsync.lamiral.info/dist2/imapsync_2.314.zip \
  --output /tmp/imapsync_2.314.zip
sha256sum /tmp/imapsync_2.314.zip
# Vérifier visuellement l'origine et l'empreinte, puis enregistrer la référence :
gh variable set IMAPSYNC_WINDOWS_ZIP_SHA256 \
  --body "$(sha256sum /tmp/imapsync_2.314.zip | awk '{print $1}')" \
  --repo technifree/LibraMail
```

La référence ainsi enregistrée doit rester inchangée pour les builds de
LibraMail 0.6.2. Ne jamais remplacer une empreinte échouée par celle d'un
nouveau fichier sans validation explicite de la provenance.

### Récupérer une publication après échec de compilation

Si le tag `v0.6.2` existe déjà, il ne faut **pas** supprimer ou déplacer le tag,
ni relancer `./github.sh release 0.6.2`. Après intégration et push du seul
correctif CI sur `master`, relancer explicitement le workflow depuis `master` :

```bash
gh workflow run release.yml --ref master -f version=0.6.2
gh run list --workflow release.yml --limit 3
```

Ce mode de reprise confirme que le tag d'origine est un ancêtre de `master` et
refuse toute modification applicative entre le tag et la reprise. Les éléments
compilés proviennent alors du dernier commit de `master` contenant uniquement
le correctif des scripts de packaging. Le tag reste inchangé ; documenter cette
particularité si l'origine exacte du binaire doit être auditée.

Le succès réel de cette réparation doit être validé par le workflow distant.

## macOS experimental build (0.6.3+)

Mac builds are **not** part of the official release workflow yet. The separate
`macos-preview.yml` workflow must first pass on Intel x86_64 **and** Apple
Silicon arm64, with embedded Node/SQLite/imapsync and real-device launch tests.
The preview app is unsigned and must not be presented as a notarized release.

See [docs/MACOS_PREVIEW.md](MACOS_PREVIEW.md) for native architecture, pinned
imapsync verification, required CI variable and manual workflow instructions.

## Validation avant publication de la 0.6.3 / Before publishing 0.6.3

- Fusionner `dev-0.6.3` vers `master` **après** vérification de la préversion et des tests ; ne pas créer le tag sur la branche de développement.
- Vérifier `IMAPSYNC_WINDOWS_ZIP_SHA256` et `IMAPSYNC_MACOS_X64_SHA256` dans les variables GitHub du dépôt.
- Lancer `./github.sh check`, puis `./github.sh release 0.6.3` depuis `master` uniquement après décision de publier.
- Les paquets macOS sont destinés aux essais volontaires, pas à une distribution stable ou notarifiée.
