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
   python3 tools/set_version.py 0.6.2
   ./github.sh notes 0.6.2
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
   git commit -m "Prepare LibraMail 0.6.2"
   ```

   `./github.sh check` validates documentation consistency and runs the tests.
   All personal data must remain outside Git.

## Publish a release

```bash
./github.sh release 0.6.2
```

`release` requires a clean Git working tree and an authenticated `gh` session.
It validates bilingual changelog content *before* changing files, synchronizes
version markers and notes, executes the full local preflight, then creates the
commit (if necessary) and tag and pushes them. GitHub Actions builds Linux and
Windows artifacts and publishes the release with bilingual notes and checksums.

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
- `build.yml`: manual build for Linux and Windows
- `release.yml`: tag-triggered verification, bilingual release-note integrity,
  package builds and GitHub Release publication

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
   python3 tools/set_version.py 0.6.2
   ./github.sh notes 0.6.2
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
   git commit -m "Préparer LibraMail 0.6.2"
   ```

   Le contrôle `check` bloque les notes obsolètes et vérifie la cohérence du
   README, le code et la sécurité. Ne jamais intégrer le dossier privé `data/`.

## Publier la version

```bash
./github.sh release 0.6.2
```

Le script refuse les modifications locales non validées et les tags existants.
Il contrôle le `CHANGELOG.md` bilingue avant de modifier la version, synchronise
les documents, lance les tests et pousse le commit et le tag vers GitHub.
GitHub Actions compile ensuite les paquets Linux et Windows et crée la page
Releases avec notes bilingues, téléchargements et empreintes SHA-256.

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
