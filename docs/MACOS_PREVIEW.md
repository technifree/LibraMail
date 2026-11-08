# LibraMail — macOS preview / Préversion macOS

**Status:** experimental. For 0.6.3 and later, the official GitHub Release may contain clearly labeled **experimental** macOS assets, in addition to stable Linux and Windows packages. macOS is not declared stable until real-device and Apple signing/notarization qualification.

**Statut :** expérimental. La Release GitHub 0.6.3 peut inclure des ZIP macOS explicitement marqués **-experimental**, à côté des paquets Linux et Windows. Il ne s'agit pas d'une version Mac stable tant que les essais réels, la signature et la notarisation ne sont pas effectués.

## Intended targets / Plateformes prévues

- macOS Intel (`macos-15-intel`, x86_64), native Neutralino and Node.js, official imapsync Darwin x86_64 binary with repository-approved SHA-256.
- macOS Apple Silicon (`macos-15`, arm64), native Neutralino and Node.js, imapsync built from the pinned 2.314 source with PAR::Packer. If native packaging fails, the workflow fails rather than producing an incomplete app.
- Both outputs are unsigned/unnotarized `.app` bundles in ZIP archives, with native SQLite and no user data.

## One-time Intel imapsync verification / Empreinte Intel

Retrieve the upstream executable yourself and check its origin before approving the SHA-256:

```bash
curl -fL --retry 3 \
  https://imapsync.lamiral.info/dist2/imapsync_bin_Darwin_x86_64 \
  -o /tmp/imapsync_bin_Darwin_x86_64
shasum -a 256 /tmp/imapsync_bin_Darwin_x86_64
```

**From Linux**, use `sha256sum` instead of `shasum -a 256`.
Once verified, explicitly approve the checksum for CI (no binary is committed):

```bash
gh variable set IMAPSYNC_MACOS_X64_SHA256 \
  --repo technifree/LibraMail \
  --body "$(sha256sum /tmp/imapsync_bin_Darwin_x86_64 | awk '{print $1}')"
```

## Launch preview workflow / Lancer les tests

Do not merge this experimental workflow into `master` just to launch its first test. GitHub requires a workflow to be present on the default branch before `workflow_dispatch` works. For the **first qualification**, pushing the `dev-0.6.3` branch automatically starts the separate preview pipeline, without publishing a Release:

```bash
# From the local dev-0.6.3 branch, after the preflight tests and commit:
git push -u origin dev-0.6.3
gh run list --workflow macos-preview.yml --branch dev-0.6.3 --limit 5
```

Before pushing, set the Intel imapsync checksum with `gh variable set IMAPSYNC_MACOS_X64_SHA256` as shown above. If it is absent, the Intel job deliberately fails. Retrieve failure logs with:

```bash
gh run list --workflow macos-preview.yml --branch dev-0.6.3 --limit 1 \
  --json databaseId --jq '.[0].databaseId'
# Then: gh run view <RUN_ID> --log-failed
```

**Only after** this workflow has been merged to the default branch is manual dispatch with `gh workflow run macos-preview.yml --ref master` possible. The preview workflow itself does not publish GitHub Releases. When ready for a 0.6.3 release, merge the tested development branch into `master` and use the separate publication workflow (see `docs/PUBLISHING.md`). The preview pipeline creates an artifact **only after** the embedded runtime and native packages pass checks.

## Validation before official release

1. Verify the ZIP contains `LibraMail.app`, and launches from Finder on each architecture.
2. Check that `~/Library/Application Support/LibraMail/data` is writable and that no state is written into `/Applications/LibraMail.app`.
3. Verify a complete migration IMAP simulation (no deletion), and check that `imapsync` runs independently of Homebrew/CPAN on user machines.
4. Test mail read state and navigation, calendar, backups, clean exit, and reopened sessions.
5. Set up Developer ID signing and Apple notarization before distributing publicly; **do not** advise users to disable Gatekeeper globally.

A compiled artifact alone does not establish a production-ready macOS application.

## Automated execution tests / Tests d’exécution automatiques

After producing each ZIP, the native macOS runner executes `tools/smoke_macos_package.sh` **before uploading** the experimental artifact. A failure prevents publication of that preview artifact.

- Checks the checksum of the ZIP, extracts `LibraMail.app`, validates `Info.plist` and executable permissions.
- Verifies the CPU architecture of the bundled Node.js, Neutralino and imapsync executables and checks for Homebrew dynamic-library paths.
- Executes bundled imapsync with an isolated environment (without `PERL5LIB`, Homebrew or external packages).
- Loads bundled `better-sqlite3`, writes and reads a temporary SQLite database, launches the **bundled Node.js backend**, authenticates to its loopback RPC service, invokes `security.status`, then requests `app.shutdown`.
- Confirms the RPC session file is removed and that tests do not write personal data inside the packaged application. Temporary state is deleted.

The tests **do not** exercise the graphical window, Gatekeeper, notarization, real mail accounts, SMTP delivery or an IMAP migration. A passing preview is still not a fully qualified stable macOS release.

## Official GitHub Release integration (0.6.3+) / Intégration aux Releases

`release.yml` runs native macOS builds for **both** architectures after source verification, with the same mandatory smoke tests as this preview pipeline. Archives are renamed with `-experimental` and given matching SHA-256 checksum files. A failing macOS job prevents publication of the entire Release; legacy 0.6.2 tags are exempt. The local `release.sh` refuses to tag the development branch.

Le workflow de publication vérifie **les deux** architectures macOS. Les ZIP expérimentaux possèdent une empreinte SHA-256 et restent non signés et non notarisés. Si l'un des deux tests Mac échoue, la Release n'est pas publiée.
