# OpenMinion Desktop Certification Readiness Matrix

Status: active
Last updated: 2026-09-12

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
| OpenMinion installation and daemon lifecycle | pinned PyPI 0.0.18; isolated config; real start/status/stop proof | development-ready |
| Text chat and saved sessions | real PyPI 0.0.18 CLI and production Electron GUI; first send, task switching, drafts, resizing, outage/restart recovery, canonical close | development-ready |
| Provider errors and recovery | real PyPI daemon with a local controlled HTTP provider | locally verified; paid-provider acceptance pending |
| Cancellation | authenticated request and saved-event evidence; PyPI 0.0.18 can complete an in-flight provider request after acknowledgement | runtime interruption gap remains |
| Approvals, media, artifacts, full Focus commands | preview UI and legacy typed client; public-interface adaptation pending | not connected |
| Signed and notarized macOS app | no evidence | not ready |
| Desktop SQLite name migration and restart | fresh native legacy-browser import, saved/reset names and preserved runtime paths | verified for this bounded migration |
| Full runtime update, rollback, restore and uninstall | no complete end-to-end evidence | not ready |
| Windows and Linux packages | no evidence | not ready |
| Remote daemon operation | out of the current local profile | not ready |
| Public release | release workflow intentionally absent | not ready |

## Remaining Alpha Caveats

1. Provider-free and unsigned-package checks do not prove provider-backed
   behavior.
2. Native capture requires an authorized macOS permission context.
3. Daemon lifecycle proof does not certify chat, sessions, approvals, media, or
   provider-backed outcomes.
4. A packaged application is not a release candidate until the release floor
   in [RELEASING.md](../RELEASING.md) is complete.

Do not promote an unsigned package build into a release claim. Update this
matrix only when matching exact evidence exists.
