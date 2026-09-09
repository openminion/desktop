# OpenMinion Desktop API Compatibility

Status: active
Last updated: 2026-09-08

Purpose: record the supported application and daemon compatibility posture for
OpenMinion Desktop.

## Supported application boundary

OpenMinion Desktop is an application, not a reusable JavaScript library. It has
no supported npm import surface.

Its supported user-facing boundary is the local application behavior described
in [README.md](README.md), [SUPPORT.md](SUPPORT.md), and `docs/`.

## Desktop-daemon boundary

The Desktop main process owns installation and lifecycle. It currently installs
the pinned `openminion==0.0.18` PyPI package into app-managed storage and calls
the ordinary `config init` and `daemon start/status/stop` commands. OpenMinion
remains the owner of sessions, messages, approvals, policy, artifacts, and agent
execution. Desktop owns presentation, local attachment grants, capture
lifecycle, and operating-system integration.

Desktop does not require or add a Desktop-specific command, bootstrap endpoint,
or lease protocol in OpenMinion. The main process keeps the managed executable,
runtime roots, and configuration path outside the renderer boundary.

## Current integration status

Lifecycle integration works with the public PyPI `0.0.18` command surface and
has real-daemon start/status/stop proof. Desktop main invokes fixed `sessions
list/show/close` and `export transcript` operations for saved conversations.
Text turns use authenticated loopback `POST /v1/turn/stream`; cancellation uses
`POST /v1/turn/{trace_id}/cancel`. Executable paths, config, and IPC tokens remain
main-only. Prompts are HTTP request bodies and never process arguments.

A new task is an in-memory draft until the first canonical turn creates it.
Desktop maps CLI transcript inbound/outbound roles to user/assistant display
roles and recovers history from OpenMinion. Session agent selection is preserved
when sending a follow-up. Like Focus, Desktop supplies `caller_handles_delivery`
and resume metadata to acknowledge displayed replies and continue the canonical
thread. The pinned one-shot `run` command omits that delivery metadata and replays
an undelivered reply on a follow-up, so it is not used for Desktop turns.
No empty-session prompt is injected.

Approval decisions, media, artifacts, full Focus commands, and active-turn
reattachment remain incomplete. They must use existing public interfaces without
restoring Desktop-only code in the OpenMinion package. The legacy typed HTTP
client remains for its existing tests and shared validation; the live supervisor
uses `CliClient` exclusively.

## Profile Configuration

Desktop main edits its existing OpenMinion JSON config through a bounded Settings
form and a native JSON import picker. Only editable profile metadata and key
presence flags cross to the renderer. Replacement credentials travel to main as
write-only inputs; stored credentials, daemon tokens, paths, and full configs
remain main-only. Imports update the shared provider bindings required by PyPI readiness while
preserving existing agents' effective provider settings in per-agent overrides.

Before replacing the config, main invokes `config show` with the candidate file
using the installed CLI. It preserves a private backup, replaces the file
atomically, and restarts through the ordinary daemon lifecycle commands. Active
Desktop turns block changes; new submissions are fenced while applying them.
Validation failures do not replace the original file. This checks configuration
loading, not provider authentication or quota. See [Getting Started](docs/getting-started.md)
for the supported fields and import boundaries.

## Internal application surfaces

The preload API and the TypeScript modules under `src/` are internal application
surfaces. Changes to them must remain coupled to focused tests, but they are not
promised as third-party APIs.

## Compatibility posture

Current project stage: development alpha.

Compatibility expectations for the documented boundary are:

1. prefer additive protocol and user-facing changes,
2. call out removals or incompatible changes in [CHANGELOG.md](CHANGELOG.md),
3. test Desktop lifecycle changes against the pinned public package,
4. validate later transport work against the existing public interface it uses,
   and
5. do not describe lifecycle proof as chat or provider-backed proof.
