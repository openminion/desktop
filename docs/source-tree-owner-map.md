# OpenMinion Desktop Source Tree Owner Map

Status: active
Last updated: 2026-10-17

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
public lifecycle, session, transcript, task control, report, and turn operations through `CliClient`.
`src/main/focus-status.ts` mirrors the pinned CLI public status wording for
structured progress keys and tools. It never interprets raw diagnostic prose;
keep its presentation tables aligned when updating the supported runtime.
`src/renderer/tasks.ts` presents runtime task facts and the actions core reports;
`src/shared/tasks.ts` describes the bounded task-control bridge.
`src/shared/reports.ts` describes agent/tool inventories and canonical token output;
export destinations remain in the native save dialog and main process.
The managed executable, roots, config path, and
credentials remain main-only facts.

Prompt queue operations stay in `src/main/cli-client.ts`, using the public
session turn-input and turn-control routes for list, enqueue, move, remove and
cancel-and-run-next.
`src/shared/contracts.ts` defines their typed bridge; `src/main/index.ts` and
`src/preload/index.ts` expose only those fixed operations. `src/renderer/app.ts`
presents **Up next** and its controls. OpenMinion owns queue persistence and
execution; Desktop's SQLite store still owns unsent drafts, not queued prompts.

`src/main/bootstrap.ts` chooses stable packaged-app paths before Electron is ready
and admits one app instance per Desktop root. `src/main/desktop-store.ts` owns
SQLite schema versioning, legacy chat-name import and Desktop presentation data.
It records existing runtime locations without moving core-owned files.

`src/main/runtime-manifest.ts` owns bounded JSON parsing, PEP 440 ordering and
compatible source/binary offer selection. The installer owns verified wheel or
paired-executable staging; the
supervisor owns notification-only checks and first-startup activation. The
existing SQLite store owns pending identity and durable launch intent. There is
no second updater service or runtime database.

Cross-process changes must preserve the main/preload/renderer authority split
and update focused tests plus [API_COMPATIBILITY.md](../API_COMPATIBILITY.md)
when the daemon boundary changes.
