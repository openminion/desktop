# OpenMinion Desktop API Compatibility

Status: active
Last updated: 2026-10-03

Purpose: record the supported application and daemon compatibility posture for
OpenMinion Desktop.

## Supported application boundary

OpenMinion Desktop is an application, not a reusable JavaScript library. It has
no supported npm import surface.

Its supported user-facing boundary is the local application behavior described
in [README.md](README.md), [SUPPORT.md](SUPPORT.md), and `docs/`.

## Desktop-daemon boundary

The Desktop main process owns installation and lifecycle. It currently installs
the pinned `openminion==0.0.29` PyPI package into app-managed storage and calls
the ordinary `config init` and `daemon status/logs` commands. Main starts the
public `openminiond serve` entrypoint as a foreground child and retains its
process handle. It signals that child only after rechecking the PID and canonical
config/data paths; external or replaced daemons are never stopped. OpenMinion
remains the owner of sessions, messages, approvals, policy, artifacts, and agent
execution. Desktop owns presentation, local attachment grants, capture
lifecycle, and operating-system integration.

Desktop does not require or add a Desktop-specific command, bootstrap endpoint,
or lease protocol in OpenMinion. The main process keeps the managed executable,
runtime roots, and configuration path outside renderer control.

## Identity editing availability

Identity settings use the public `identity inspect`, `identity validate`, and
revision-checked `identity apply` commands included in the pinned PyPI `0.0.29`
runtime. Desktop reads, validates, saves, verifies, and reloads identity through
fixed typed operations; it does not write profiles directly. `/identity reload`
restarts the app-owned daemon so cached policy and tool constraints reload from
the canonical profile. Unsupported older runtimes show an explanation and a
link to Runtime settings; the unavailable editor stays hidden. Empty profile
results are reported separately.

## Current integration status

Lifecycle integration works with the public PyPI `0.0.29` command surface and
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

Approval decisions use the
authenticated local approval-resume operation and negotiated turn stream.
Desktop can allow once or deny the exact pending request; policy and grant
ownership remain in OpenMinion. Media, artifacts,
full Focus commands, and active-turn reattachment remain incomplete. They must
use existing public interfaces without restoring Desktop-only code in the
OpenMinion package. The live supervisor uses the CLI-backed client exclusively.

## Daemon Diagnostics

The connection details expose **Daemon status** and **View logs** through a
fixed `daemon.inspect("status" | "logs")` preload operation. Main validates the
app frame and the requested operation, then runs `daemon status` or
`daemon logs --lines 200` using the same installed executable and recorded
root arguments as the lifecycle owner. No executable, path, flag or shell
command is accepted from the renderer.

Results contain the CLI's diagnostic text, displayed literally and available
for explicit copying. This includes CLI-reported runtime paths. Inspection
works while stopped after installation and does not start, stop or reconnect
the daemon. Logs are snapshots, refreshed on request; there is no follow stream
or Desktop log store. Other service families remain unconnected.

## Local Chat Names

Desktop main stores user-chosen chat names in `desktop.sqlite`, keyed by the
canonical session ID. The fixed `chatNames.load` and `chatNames.save` preload
methods accept names only; the renderer cannot choose database paths or run SQL.
These presentation labels override visible titles without mutating OpenMinion
sessions or changing IDs used for turns, history, exports, or CLI resume. Reset
removes the local label. Existing browser-stored labels migrate once, atomically.

The database also records the installation's runtime and browser paths. Core
still owns profiles, credentials, transcripts and execution state. See
[Desktop Data](docs/getting-started.md#desktop-data) for locations and upgrade behavior.

## Runtime Updates

The narrow `runtime.control` bridge accepts PyPI/native source selection,
pause/resume, discard, installed-pin, remove-pin and exact stable-version pin
actions. Main resolves record/artifact
identities; renderer-provided URLs, paths, hashes and commands are rejected.
Policy persists in Desktop's SQLite schema three; older clients must refuse
that schema instead of silently ignoring a hold. Preparation and startup
activation both enforce pause and exact identity. Recovery-required state is
not cleared by policy controls, and no action forces a downgrade or live restart.

The fixed `runtime.status`, `runtime.check`, and `runtime.stage` bridge accepts
no executable, URL, version, root, or shell command from the renderer. Main
checks the public GitHub stable feed asynchronously at startup and every 24 hours.
Manifest records pin full metadata commits and their SHA-256 digests. Only
compatible promoted records are eligible; no source fallback or downgrade occurs.

Explicit **Prepare update** verifies the selected artifact's size and hash and
stages it in a separate location. PyPI records install the official wheel into
an isolated environment. Binary records download both the CLI and daemon from
the immutable `openminion/runtime` GitHub Release, accept only GitHub's bounded
release-asset redirect, verify each executable independently, and retain one
shared identity derived from both digests. Activation occurs on the first startup attempt only,
under the app-instance lock, with private, non-adopted roots and no live daemon.
SQLite records launch intent before candidate execution against live data.
Failed/interrupted launch leaves a recovery marker instead of an automatic
older-runtime restart. Developer executable overrides are unmanaged.

Publication and compatibility certification remain pending. Missing feeds fail
as update checks without changing the installed pin. Selecting the native source
does not install or relabel the active runtime, and an empty binary feed offers
no update; only centrally verified, promoted records with explicit Desktop
compatibility can become eligible.

## Reports And Transcript Export

Main reads authenticated `GET /v1/agents` and `GET /v1/tools`, projecting only
public display fields. Token reports use fixed `status tokens --session-id`
arguments. Transcript export uses fixed `export transcript --format md` arguments
and a native save dialog; neither the file path nor raw exported transcript
crosses into the renderer. No generic CLI or HTTP request method is exposed.

## Task Controls

Main invokes only `tasks list/show/pause/resume/cancel --json`, with the selected
session and its canonical agent. The bridge accepts a fixed action and IDs, never
an executable, path, flags, or arbitrary command text. Only task presentation
fields and pending-decision counts cross back to the renderer. OpenMinion's task
surface remains responsible for scope, valid actions, scheduler effects, and
persistence. Desktop does not write task records or implement lifecycle rules.

## Profile Configuration

First-launch setup discovers choices through `setup --list-providers` and invokes
the installed CLI's `setup --no-chat` against a private candidate configuration.
The selected preset, model, URL, and write-only key are bounded inputs; credentials
reach setup in its child environment, never shell text or command arguments.
The existing Settings apply path validates and installs the result. This uses
core's profile builder without copying its provider catalog into Desktop.

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
