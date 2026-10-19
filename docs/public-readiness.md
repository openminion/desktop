# OpenMinion Desktop Public Source Readiness

Status: private preparation; visibility change not authorized
Last updated: 2026-10-19

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
  for private vulnerability reporting. Bug and feature templates collect scoped
  reproduction/parity details without requiring paid-provider tests. GitHub
  activates templates from the default branch; changes staged only on `dev`
  still require reviewed promotion. Do not attach credentials, unredacted
  logs, private prompts, or personal file paths to public reports.

## Before changing visibility

The maintainer performing the visibility change must retain an exact commit
and dated evidence for each gate. Source validation alone cannot close them.

| Gate | Acceptance | Current boundary |
| --- | --- | --- |
| Source and history disclosure | Scan heads, tags and historical PR heads, and inspect historical paths, assets, commit metadata and licenses; resolve findings before exposure | The expanded 2026-10-18 audit covered 216 reachable commits, 1,227 blob versions and 134 historical paths, including 73 PR heads and exposed force-pushed revisions. Expanded Git and added full-blob scans found zero secrets. Automated detection is not a privacy or rights signoff |
| Hosted-content disclosure | Review retained Actions logs/artifacts, PR and issue bodies/comments, releases, wiki and attachments; redact or remove confidential material before visibility changes | The 2026-10-18 expanded inventory covers 267 runs, 914 nonempty log files, 73 PRs, 19 comments and 65 retained description revisions. Secret scans passed, but two old PR description revisions still disclose personal paths. Current bodies are clean; remove only the affected revisions before publication. External image bytes and contextual maintainer approval remain outside the scan |
| License and branding | Confirm authority to publish every source file and bundled asset, including historical versions; retain compatible notices | Apache-2.0, NOTICE and brand boundaries exist; packaging requires both license notices in the application archive. Asset origin does not itself establish publishing rights |
| Dependency security | Record the full install/build audit, triage unresolved advisories and verify any upgrade with actual package builds | Forge 8.0.1 leaves four high audit reports in one DMG build chain; upstream resolution or explicit maintainer risk disposition remains open |
| Reproducible contribution | Clean dependency install from the lockfile without private registry, Git credentials or sibling checkouts; both Quality jobs pass | Local and hosted evidence must identify the exact revision. Actions budget limits currently block new hosted acceptance; restore capacity and rerun required checks before promotion. Public fork proof follows the switch |
| Merge controls | Require current Quality checks, up-to-date branches, reviewed promotion, and no force push/deletion on `main`; verify effective settings | GitHub returns a plan restriction for protection on this private repo; upgrade the plan or configure immediately at visibility change |
| Private security reports | Publish a private reporting destination; enable and externally verify GitHub private vulnerability reporting at launch | The maintainer selected `hello@openminion.com` for security fallback and conduct reports on 2026-10-19; both policies name it. GitHub reporting still needs launch verification |
| Public fork policy | Require approval for first-time outside workflows; keep fork PR tokens read-only and secrets unavailable | Verify effective GitHub settings at launch; ordinary quality checks must not depend on maintainer secrets |

The remaining audit chain is `@electron-forge/maker-dmg` →
`electron-installer-dmg` → `appdmg` → `image-size`. The
[ICNS parsing advisory](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)
can hang a build. On 2026-10-18, the latest `appdmg` (0.6.6) still requires
`image-size ^0.7.4`. Patched `image-size` 2.0.3 and 2.0.4 change both the export
and file-reading API: an isolated check of the actual `appdmg` call against the
Desktop icon succeeded with 0.7.5 and failed with both patched versions. A
compatible upstream release or explicit maintainer disposition is required;
forcing an override would break DMG packaging. Do not suppress the report. A
production-only npm audit is not sufficient: install/build tools execute code,
and this application bundles selected runtime modules from development dependencies.

## Maintainer decisions

Before source publication, record these decisions against the reviewed revision:

- **Disclosure and rights:** approve publication of current and historical code,
  contributor attribution, PR discussion and retained CI logs; confirm authority
  to publish bundled artwork. The PNG retains documented OpenAI creation
  provenance; the hash and origin in [assets](../assets/README.md) establish
  identity, not publishing rights or contextual privacy approval.
- **Build dependency:** resolve the DMG advisory above or explicitly accept its
  disclosed build-tool limitation for source publication. This decision does not
  certify a stable binary or dismiss dependency risks in general.
- **Launch controls:** choose a plan upgrade or immediate protection setup at the
  approved visibility switch. Verify private vulnerability reporting externally.
  The maintainer-designated email route is published in `SECURITY.md` and
  `CODE_OF_CONDUCT.md`; keep it monitored for both kinds of reports.

GitHub currently rejects protection readback for this private repository with a
plan restriction, returns no usable private-reporting readback, and disallows
public fork-approval configuration while private. These responses do not prove
that the desired settings are effective. Keep the switch pending until the
maintainer can perform and verify the sequence below. Ordinary PR workflows use
read-only tokens. The separate canonical-main runtime qualification workflow
creates evidence PRs, so disabling repository-wide PR creation would break that
existing maintenance flow; verify untrusted-job permissions at their owner.

## Visibility switch and acceptance

Only an explicit maintainer decision authorizes making the repository public.
GitHub documents that [changing visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)
can expose Actions history and logs. A secret scan of Git cannot substitute for
reviewing that hosted content.

At the approved switch:

1. Remove the original description revisions of PRs
   [#18](https://github.com/openminion/desktop/pull/18) and
   [#33](https://github.com/openminion/desktop/pull/33) and recheck their deletion
   state. In each description’s edited menu, open the original revision and use
   **Options → Delete revision from history**. Keep the current description and
   PR intact. Editing the current body does not remove its history. Retain
   sanitized verification only; do not publish the original personal paths.
2. Resolve the maintainer decisions above and verify the documented private
   contact routes. Restore Actions capacity and rerun blocked required checks.
   [Public standard runners](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
   become free only after the visibility switch; it cannot prove a private pre-switch check passed. If capacity remains
   unavailable, stop at this gate rather than silently bypassing it.
3. Promote the reviewed source through the `dev` → `main` process and record the
   exact revision. Recheck the disclosure gates if either branch moved.
4. Change visibility, enable/verify private security reporting, and immediately
   configure and read back effective branch protections. Require
   **Quality (ubuntu-latest)** and **Quality (macos-latest)** on `main`, with
   strict/up-to-date checks and administrator enforcement, matching CLI's
   protected promotion boundary. Enforce review and reject force pushes/deletion.
5. Verify [Actions fork settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository),
   including first-time contributor approval and no secret or write-token access
   for untrusted PR jobs. Keep package publishing restricted to canonical `main`.
6. Check the public issue chooser on the promoted default branch: bug and
   feature templates render, blank issues remain available, and support/security
   links reach the documented routes. A template link does not establish that
   private vulnerability reporting is enabled.
7. From an unauthenticated environment, clone the public default branch, install
   the lockfile, run the documented checks, and verify public documentation links.
8. Submit a real fork PR to `dev` without secrets. Confirm that the approved
   workflow runs, validates its commit range, and passes both Quality jobs.
   Record the PR and workflow receipts; do not substitute a same-repo PR.

Opening the source does not publish a new binary. Windows/Linux maker proof,
platform permissions, provider-live behavior, signing and clean-machine
certification retain their own evidence in the release readiness matrix.
