# OpenMinion Desktop Certification Readiness Matrix

Status: active
Last updated: 2026-10-19

Purpose: summarize the current proof posture for the standalone Desktop
application.

## Matrix

| Surface | Current evidence | Current posture |
| --- | --- | --- |
| Provider-free code quality | format, lint, type, public-surface, tests, and build | ready for pull-request use |
| Public repository surface | required-file, local-link, portable-path, heading, lifecycle-metadata, and documented-command validation | aligned and enforced |
| GitHub Actions definitions | actionlint, Linux quality, and macOS quality/package/native smoke passed at `dd3e793` in [CI attempt 2](https://github.com/openminion/desktop/actions/runs/39235407184/attempts/2) | fresh hosted proof required for each PR; see [public-source gates](public-readiness.md) |
| Development dependency audit | Forge 8.0.1 reduces 37 findings to 4 high reports in one DMG build chain (`appdmg` → `image-size`) | upstream fix/disposition required; not a clean full audit |
| Linux source compatibility | provider-free CI | supported as a CI host, not a packaged product |
| macOS development app | local start, package smoke, and runtime-file allowlist | development-ready |
| macOS native capture | opt-in permissioned test | requires acceptance on an authorized host |
| OpenMinion installation and daemon lifecycle | pinned PyPI 0.0.29; isolated config; real start/status/stop proof | development-ready |
| Paired binary runtime staging | bounded immutable-release redirects, independent CLI/daemon integrity checks, pending activation and rollback-on-failure fixtures | implemented; public/native certification pending |
| Text chat and saved sessions | real PyPI 0.0.29 CLI and production Electron GUI; first send, task switching, drafts, resizing, outage/restart recovery, canonical close | development-ready |
| Provider errors and recovery | real PyPI daemon with a local controlled HTTP provider | locally verified; paid-provider acceptance pending |
| Shared prompt queue | published 0.1.7 and native two-process Desktop check on macOS: queue/draft restoration, exact removal, stop-and-run-next, approved file write and one canonical completion | bounded restart/effect acceptance passed on 2026-10-19 using a controlled local provider; automatic advancement and arbitrary running-turn discovery remain open; managed pin remains 0.0.29 |
| Cancellation | authenticated request and saved-event evidence; PyPI 0.0.29 can complete an in-flight provider request after acknowledgement | runtime interruption gap remains |
| Request-bound tool approvals | pinned PyPI daemon + built Electron allow-once proof; deny/retry/replay/unit coverage | managed-runtime verified |
| Identity settings and commands | pinned PyPI 0.0.29 inspect/validate/apply; native view, draft, verify, save, conflict, and reload proof | development-ready |
| Media, artifacts, full Focus commands | preview UI only; public-interface adaptation pending | not connected |
| Signed and notarized macOS app | no evidence | not ready |
| Desktop SQLite name migration and restart | fresh native legacy-browser import, saved/reset names and preserved runtime paths | verified for this bounded migration |
| Full runtime update, rollback, restore and uninstall | no complete end-to-end evidence | not ready |
| Windows and Linux packages | unsigned package targets and development distribution workflow exist | runtime certification and current build acceptance remain separate |
| Remote daemon operation | out of the current local profile | not ready |
| Public source repository | contribution workflow and launch checklist | public since 2026-10-19; [remaining launch acceptance](public-readiness.md) is tracked separately |
| Public development distribution | unsigned prerelease process in `openminion/runtime` | development evidence only |
| Stable public release | signing and platform certification incomplete | not ready |

## Runtime candidate qualification

The managed default remains PyPI `0.0.29`. The 2026-10-18 macOS probes of
published `0.1.7` did not complete acceptance: the durable-conversation restart
check failed (a repeated run exceeded its 30-second startup limit), and the
native GUI check stopped at a tool-dependency status comparison. A separate
CLI-only start/stop/start probe passed, so these results do not establish a
single runtime root cause. Keep the candidate unqualified until the existing
lifecycle and GUI checks pass.

A pinned `0.0.29` GUI rerun also encountered differing readiness snapshots.
Direct requests to its daemon reproduced Semgrep changing from `unhealthy`
(`version_probe_timeout`) to `ready` on later requests. Dependency status is
probed per request; this observation is not evidence of a Desktop display
mapping defect, nor does it close the full GUI acceptance requirement.

This does not invalidate the separate bounded queue evidence above or establish
Windows/Linux compatibility. Changing the default pin, publishing certified
runtime metadata, and testing a public-feed upgrade each require their own
proof under [Releasing](../RELEASING.md). Do not change the pin merely because a
newer package exists on PyPI.

## Remaining Alpha Caveats

1. Provider-free and unsigned-package checks do not prove provider-backed
   behavior.
2. Native capture requires an authorized macOS permission context.
3. Daemon lifecycle proof does not certify chat, sessions, approvals, media, or
   provider-backed outcomes; each connected surface needs its own evidence.
4. A packaged application is not a release candidate until the release floor
   in [RELEASING.md](../RELEASING.md) is complete.

Do not promote an unsigned package build into a release claim. Update this
matrix only when matching exact evidence exists.
