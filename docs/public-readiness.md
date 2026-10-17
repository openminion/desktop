# OpenMinion Desktop Public Source Readiness

Status: private preparation; visibility change not authorized
Last updated: 2026-10-17

This checklist separates opening the source from shipping a certified Desktop
release. OpenMinion CLI remains the execution owner. Public source does not
claim full CLI/Focus parity, signed installers, or supported behavior on every
packaging target. See [Focus parity](focus-parity.md) and
[Releasing](../RELEASING.md) for those independent requirements.

## Contributor contract

- Use Node.js 24 and npm 11; install with `npm ci` and run `npm run ci-check`.
  Source checks must work without paid-provider credentials or sibling repos.
- Work from current `dev`, submit a focused feature/fork PR to `dev`, and wait
  for review and both hosted Quality jobs. Maintainers promote `dev` to `main`
  separately. Follow [Contributing](../CONTRIBUTING.md).
- Keep `package.json`'s `private: true`: it prevents accidental npm publication;
  it does not control GitHub visibility or restrict the Apache-2.0 source license.
- Use [Support](../SUPPORT.md) for bug reports and [Security](../SECURITY.md)
  for private vulnerability reporting. Do not attach credentials, unredacted
  logs, private prompts, or personal file paths to public reports.

## Before changing visibility

The maintainer performing the visibility change must retain an exact commit
and dated evidence for each gate. Source validation alone cannot close them.

| Gate | Acceptance | Current boundary |
| --- | --- | --- |
| Source and history disclosure | Scan all reachable refs and inspect historical paths, assets, commit metadata and licenses; resolve findings before exposure | Gitleaks 8.30.1 scanned 211 reachable commits with zero secret findings on 2026-10-17; automated detection is not a privacy or rights signoff |
| Hosted-content disclosure | Review retained Actions logs/artifacts, PR and issue bodies/comments, releases, wiki and attachments; redact or remove confidential material before visibility changes | Separate from Git history; maintainer signoff required |
| License and branding | Confirm authority to publish every source file and bundled asset, including historical versions; retain compatible notices | Apache-2.0, NOTICE and brand boundaries exist; asset origin does not itself establish publishing rights |
| Dependency security | Record the full install/build audit, triage unresolved advisories and verify any upgrade with actual package builds | Forge 8.0.1 leaves four high audit reports in one DMG build chain; upstream resolution or explicit maintainer risk disposition remains open |
| Reproducible contribution | Clean dependency install from the lockfile without private registry, Git credentials or sibling checkouts; both Quality jobs pass | Local and hosted evidence must identify the exact revision; public fork proof follows the switch |
| Merge controls | Require current Quality checks, up-to-date branches, reviewed promotion, and no force push/deletion on `main`; verify effective settings | GitHub returns a plan restriction for protection on this private repo; upgrade the plan or configure immediately at visibility change |
| Private security reports | Enable private vulnerability reporting and verify the linked reporting route works for an external user | An advisory link alone is not proof that reporting is enabled |
| Public fork policy | Require approval for first-time outside workflows; keep fork PR tokens read-only and secrets unavailable | Verify effective GitHub settings at launch; ordinary quality checks must not depend on maintainer secrets |

The remaining audit chain is `@electron-forge/maker-dmg` →
`electron-installer-dmg` → `appdmg` → `image-size`. The
[ICNS parsing advisory](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)
can hang a build. The available fix is outside `appdmg`'s declared dependency
range. Do not suppress the report or force an untested major override. A
production-only npm audit is not sufficient: install/build tools execute code,
and this application bundles selected runtime modules from development dependencies.

## Visibility switch and acceptance

Only an explicit maintainer decision authorizes making the repository public.
GitHub documents that [changing visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)
can expose Actions history and logs. A secret scan of Git cannot substitute for
reviewing that hosted content.

At the approved switch:

1. Promote the reviewed source through the `dev` → `main` process and record the
   exact revision. Recheck the disclosure gates if either branch moved.
2. Change visibility, enable/verify private security reporting, and immediately
   configure and read back effective branch protections. Require
   **Quality (ubuntu-latest)** and **Quality (macos-latest)** on `main`, with
   strict/up-to-date checks and administrator enforcement, matching CLI's
   protected promotion boundary. Enforce review and reject force pushes/deletion.
3. Verify [Actions fork settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository),
   including first-time contributor approval and no secret or write-token access
   for untrusted PR jobs. Keep package publishing restricted to canonical `main`.
4. From an unauthenticated environment, clone the public default branch, install
   the lockfile, run the documented checks, and verify public documentation links.
5. Submit a real fork PR to `dev` without secrets. Confirm that the approved
   workflow runs, validates its commit range, and passes both Quality jobs.
   Record the PR and workflow receipts; do not substitute a same-repo PR.

Opening the source does not publish a new binary. Windows/Linux maker proof,
platform permissions, provider-live behavior, signing and clean-machine
certification retain their own evidence in the release readiness matrix.
