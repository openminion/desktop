# OpenMinion Desktop Certification Readiness Matrix

Status: active
Last updated: 2026-09-07

Purpose: summarize the current proof posture for the standalone Desktop
application.

## Matrix

| Surface | Current evidence | Current posture |
| --- | --- | --- |
| Provider-free code quality | format, lint, type, public-surface, tests, and build | ready for pull-request use |
| Public repository surface | required-file, local-link, portable-path, heading, lifecycle-metadata, and documented-command validation | aligned and enforced |
| GitHub Actions definitions | actionlint plus successful hosted execution | aligned and enforced |
| Development dependency audit | known Electron Forge transitive findings; no `node_modules` shipped | monitored through Dependabot; not a clean full audit |
| Linux source compatibility | provider-free CI | supported as a CI host, not a packaged product |
| macOS development app | local start, package smoke, and runtime-file allowlist | development-ready |
| macOS native capture | opt-in permissioned test | requires acceptance on an authorized host |
| OpenMinion daemon contract | explicit real-daemon test; command absent from OpenMinion `main` as of 2026-09-07 | development-branch integration only |
| Signed and notarized macOS app | no evidence | not ready |
| Update, rollback, migration, uninstall | no evidence | not ready |
| Windows and Linux packages | no evidence | not ready |
| Remote daemon operation | out of the current local profile | not ready |
| Public release | release workflow intentionally absent | not ready |

## Remaining Alpha Caveats

1. Provider-free and unsigned-package checks do not prove provider-backed
   behavior.
2. Native capture requires an authorized macOS permission context.
3. Desktop and OpenMinion must be tested at explicitly matched revisions; the
   current OpenMinion `main` branch is not compatible.
4. A packaged application is not a release candidate until the release floor
   in [RELEASING.md](../RELEASING.md) is complete.

Do not promote an unsigned package build into a release claim. Update this
matrix only when matching exact evidence exists.
