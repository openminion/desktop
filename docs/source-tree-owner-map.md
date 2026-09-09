# OpenMinion Desktop Source Tree Owner Map

Status: active
Last updated: 2026-09-08

Purpose: give contributors a package-local owner map without turning internal
TypeScript modules into supported third-party APIs.

## Public Boundary Shorthand

OpenMinion Desktop is an application. Its public boundary is the documented
application behavior plus the public OpenMinion interfaces it invokes. The
TypeScript trees below are internal owners, not blanket npm APIs.

## Top-level Owners

| Path | Owner |
| --- | --- |
| `src/main/` | Managed OpenMinion installation, daemon supervision, privileged OS access, media, files, security, and protocol routing |
| `src/preload/` | Narrow typed bridge from the sandboxed renderer to Electron main |
| `src/renderer/` | Chat workspace, presentation, interaction state, and capture controls |
| `src/shared/` | Contracts used on more than one Desktop process boundary |
| `tests/` | Focused contract, lifecycle, integration, and negative-path proof |
| `scripts/` | Build, commit policy, public-surface, and packaged-file validation |
| `.githooks/` | Local pre-commit and commit-message entrypoints |
| `.github/` | Hosted checks, pull-request guidance, and dependency update policy |

## Boundary Rule

The OpenMinion daemon remains outside this repository and owns agent runtime,
sessions, credentials, policy decisions, artifacts, and durable execution
truth. Do not create a second copy of those owners in Desktop.

Desktop main may install a pinned OpenMinion package and invoke its ordinary
public lifecycle, session, transcript, task control, and turn operations through `CliClient`.
`src/renderer/tasks.ts` presents runtime task facts and the actions core reports;
`src/shared/tasks.ts` describes the bounded task-control bridge.
The managed executable, roots, config path, and
credentials remain main-only facts.

Cross-process changes must preserve the main/preload/renderer authority split
and update focused tests plus [API_COMPATIBILITY.md](../API_COMPATIBILITY.md)
when the daemon boundary changes.
