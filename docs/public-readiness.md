# OpenMinion Desktop Public Source Readiness

Status: public source; launch acceptance in progress
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

## Disclosure and launch gates

The maintainer explicitly authorized public visibility on 2026-10-19. GitHub
reported `public`, and an unauthenticated API request confirmed access. The
switch preceded completion of the gates below; it does not close them. Retain
exact revisions and dated evidence rather than inferring acceptance from access.

| Gate | Acceptance | Current boundary |
| --- | --- | --- |
| Source and history disclosure | Scan heads, tags and historical PR heads, and inspect historical paths, assets, commit metadata and licenses; resolve findings before exposure | The expanded 2026-10-18 audit covered 216 reachable commits, 1,227 blob versions and 134 historical paths, including 73 PR heads and exposed force-pushed revisions. Expanded Git and added full-blob scans found zero secrets. Automated detection is not a privacy or rights signoff |
| Hosted-content disclosure | Review retained Actions logs/artifacts, PR and issue bodies/comments, releases, wiki and attachments; redact or remove confidential material before visibility changes | The 2026-10-18 expanded inventory covers 267 runs, 914 nonempty log files, 73 PRs, 19 comments and 65 retained description revisions. Secret scans passed, but two old PR description revisions still disclose personal paths. Current bodies are clean; remove only the affected revisions; this cleanup remains open after publication. External image bytes and contextual maintainer approval remain outside the scan |
| License and branding | Confirm authority to publish every source file and bundled asset, including historical versions; retain compatible notices | Apache-2.0, NOTICE and brand boundaries exist; packaging requires both license notices in the application archive. Asset origin does not itself establish publishing rights |
| Dependency security | Record the full install/build audit, triage unresolved advisories and verify any upgrade with actual package builds | Forge 8.0.1 leaves four high audit reports in one DMG build chain; upstream resolution or explicit maintainer risk disposition remains open |
| Reproducible contribution | Clean dependency install from the lockfile without private registry, Git credentials or sibling checkouts; both Quality jobs pass | Both Quality jobs passed at `dd3e793` after the switch in [CI attempt 2](https://github.com/openminion/desktop/actions/runs/39235407184/attempts/2). The runner-budget blocker is cleared. An unauthenticated clone of public `main` (`71fc075`) passed `npm ci` and `npm run ci-check`: 411 tests passed, three opt-in tests skipped. This is the older default-branch snapshot, not the pending promotion or paid-provider evidence |
| Merge controls | Require current Quality checks, up-to-date branches, reviewed promotion, and no force push/deletion on `main`; verify effective settings | API readback on 2026-10-19 confirms both Quality checks, strict freshness, administrator enforcement, and no force push/deletion on `dev` and `main`. Both require a PR. Like CLI, no additional GitHub approval count is imposed |
| Private security reports | Publish a private reporting destination; enable and externally verify GitHub private vulnerability reporting at launch | The maintainer selected `hello@openminion.com` for security fallback and conduct reports on 2026-10-19; both policies name it. GitHub API readback reports reporting enabled. The signed-out Security page shows Report a vulnerability, which reaches GitHub sign-in for the private advisory route; authenticated report submission has not been tested |
| Public fork policy | Require approval for first-time outside workflows; keep fork PR tokens read-only and secrets unavailable | API readback confirms `first_time_contributors` approval and default read-only workflow permissions. Quality jobs declare `contents: read`; [fork PR #82](https://github.com/openminion/desktop/pull/82) passed both Quality jobs at `4ea5d19` in [CI](https://github.com/openminion/desktop/actions/runs/39249955318). This maintainer-owned fork does not establish first-time outsider approval behavior |

The remaining audit chain is `@electron-forge/maker-dmg` →
`electron-installer-dmg` → `appdmg` → `image-size`. The
[ICNS parsing advisory](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)
can hang a build. On 2026-10-18, the latest `appdmg` (0.6.6) still requires
`image-size ^0.7.4`. Patched `image-size` 2.0.3 and 2.0.4 change both the export
and file-reading API: an isolated check of the actual `appdmg` call against the
Desktop icon succeeded with 0.7.5 and failed with both patched versions. A
compatible upstream release or explicit maintainer disposition is required;
forcing an override would break DMG packaging. Do not suppress the report.

The 2026-10-19 call-site review narrows the current exposure: Desktop sets only
an installer icon, so `electron-installer-dmg` supplies its bundled PNG
background. `appdmg` calls `image-size` for background dimensions and copies the
ICNS icon without parsing it through that library. The earlier icon probe tested
API compatibility, not reachability of the vulnerable parser in the configured
build. No malformed ICNS input path was demonstrated in this configuration;
the vulnerable dependency is still installed and the advisory remains open.
Reassess this boundary if the background or maker configuration changes.

A production-only npm audit is not sufficient: install/build tools execute code,
and this application bundles selected runtime modules from development dependencies.

## Maintainer decisions

The source was made public at the maintainer's explicit request before all
acceptance was complete. This records the publication decision, not a separate
rights attestation or blanket dependency-risk acceptance. These items remain:

- Confirm authority to publish current and historical code and bundled artwork.
  Asset provenance in [assets](../assets/README.md) establishes origin and
  identity, not publishing rights.
- Resolve the DMG advisory or record a specific maintainer disposition. Source
  visibility does not certify a stable binary.
- Keep `hello@openminion.com` monitored for security and conduct reports.

Ordinary PR workflows use read-only tokens. The separate canonical-main runtime
qualification workflow creates evidence PRs, so repository-wide PR creation
remains enabled for that existing maintenance flow. Untrusted Quality jobs have
no publishing permissions or provider-secret dependency.

## Visibility switch and acceptance

Only an explicit maintainer decision authorizes making the repository public.
GitHub documents that [changing visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)
can expose Actions history and logs. A secret scan of Git cannot substitute for
reviewing that hosted content.

After the 2026-10-19 switch:

1. Remove the original description revisions of PRs
   [#18](https://github.com/openminion/desktop/pull/18) and
   [#33](https://github.com/openminion/desktop/pull/33), then verify deletion.
   In each description's edited menu, open the original revision and use
   **Options → Delete revision from history**. Keep the current description and
   PR intact. Editing the body does not remove history. Record sanitized proof
   only. Browser authentication is still required for this cleanup.
2. Finish the maintainer dispositions above. The two standard hosted Quality
   jobs now pass without a paid budget increase; require fresh results for each
   new PR head rather than reusing the pre-switch failures or an older pass.
3. Merge the reviewed closeout PR to `dev`, then promote through a separate
   `dev` → `main` PR. Keep both required checks and the reviewed promotion
   process intact. Record the merge revisions.
4. Verify private reporting and the public issue chooser from outside the
   maintainer account. Bug and feature templates, blank issues, and support and
   security links must work on the promoted default branch.
5. Repeat the anonymous clean install and checks after the reviewed promotion.
   The first public-default checkout at `71fc075` passed all 411 tests, formatting,
   lint, types, local documentation-link checks and build. Its install reported
   37 dependency findings; the combined closeout branch reduces these to four.
   Do not attribute that reduction to `main` until promotion lands.
6. The real fork workflow passed for PR #82 at `4ea5d19`: commit-range
   validation, both Quality jobs and macOS package/native smoke completed.
   It ran from `wireindevice/desktop` with read-only job permissions and no
   provider secrets. A first-time outside contributor still needs to exercise
   the approval policy; do not infer that result from this maintainer-owned fork.

Opening the source does not publish a new binary. Windows/Linux maker proof,
platform permissions, provider-live behavior, signing and clean-machine
certification retain their own evidence in the release readiness matrix.
