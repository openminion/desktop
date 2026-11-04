# OpenMinion Desktop Engineering Patterns

Status: active
Last updated: 2026-11-01

Purpose: give contributors one package-local summary of the ownership,
simplicity, and boundary patterns that shape Desktop changes.

## Core Rule

Prefer single-owner, explicitly named, typed surfaces over duplicate state,
pass-through wrappers, hidden process coupling, or speculative abstraction.

Before adding structure:

1. remove the need when the behavior is unnecessary,
2. reuse the existing Desktop or OpenMinion owner when one exists,
3. prefer Electron, Node.js, or an existing dependency when it keeps the path
   direct and readable, and
4. use one direct call or small helper before adding a larger abstraction.

This is not code golf. Preserve validation, security, lifecycle, protocol,
approval, audit, and user-visible behavior.

## Process Owners

Desktop is the GUI representation of OpenMinion Focus/CLI. Focus defines the
command names, aliases, arguments, defaults, runtime behavior, busy-turn rules,
and permission semantics. Desktop presents those operations; it must not invent
a separate command language or substitute weaker behavior under the same name.
Missing integration is a parity defect, not a Desktop product distinction.
Native buttons may present file, screenshot, and window interactions without
adding Desktop-only slash commands. See [Focus Parity Contract](focus-parity.md)
for the required shared-owner integration and acceptance criteria.

1. OpenMinion owns agent semantics, sessions, policy, credentials, artifacts,
   and durable execution truth.
2. Electron main owns daemon supervision, authenticated communication, file
   grants, capture, protocols, and operating-system access.
3. Preload owns the narrow typed bridge and exact validation of renderer-visible
   values.
4. The renderer owns presentation, navigation, interaction state, and visible
   capture controls.
5. Shared modules own contracts used across more than one Desktop process.

## Current Owner Patterns

### Profiles and credentials

OpenMinion owns profile semantics, provider configuration, and runtime
validation. Desktop owns the settings workflow and typed bridge used to inspect
or change those facts. Credentials and filesystem paths stay in Electron main;
the renderer receives only the minimum typed state needed to present the form.
Do not add a renderer-side credential store or infer provider behavior from
display text.

### Tasks and delegation

OpenMinion owns task, worker, handback, and delegation lifecycle truth. Desktop
renders typed reports and submits the explicit actions exposed by the runtime.
Do not reconstruct a parallel task graph from messages, optimistic UI state, or
diagnostic prose. Keep task and delegation contracts in `src/shared/`, validate
requests in main, and make renderer state disposable and recoverable from the
runtime.

### Managed runtime updates

`src/main/runtime-manifest.ts` owns bounded manifest parsing and eligible-offer
selection. `src/main/installation.ts` owns verified staging and reuse of the
active installation. The supervisor owns notification and activation timing.
Desktop must not install an unverified artifact, treat an offered version as an
installed version, or report activation before the next-start readback proves
it.

### Desktop-only persistence

Desktop SQLite owns presentation state such as drafts, names, preferences, and
pending launch intent. It may record runtime locations, but it does not own
OpenMinion sessions, transcripts, tasks, credentials, or execution results.
Schema changes must preserve atomic migration, future-schema refusal, corrupt
file retention, and restart proof.

## Boundary Rules

Sandboxed preloads must be bundled as CommonJS, with shared contracts included
and only `electron` left external. Keep `sandbox: true` and context isolation;
do not disable them to accommodate ESM preload imports. The main process and
renderer keep their existing ESM output.

1. Treat renderer payloads as untrusted.
2. Never expose raw IPC, Node.js, filesystem, shell, credential, or generic
   network authority to the renderer.
3. Keep one source of truth for every lifecycle and protocol fact.
4. Bind security-sensitive operations to the required session, source, grant,
   frame, and lifecycle state.
5. Add focused tests before changing a process or daemon contract.

For cross-process changes, update the shared type first, then main validation,
the preload bridge, renderer behavior, and focused tests. Do not loosen the
bridge with generic invoke, arbitrary path, arbitrary URL, or untyped payload
surfaces.

## Readability Rules

Use concrete names and direct control flow. Keep comments short and limited to
non-obvious ownership, safety, or compatibility reasons. Paths should name the
subsystem and local role. Add a file only when it creates a clearer owner.

Keep generated builds, captured media, runtime state, credentials, and local
integration artifacts out of Git.

## Evidence Rules

Keep proof tiers explicit:

1. renderer/Vitest checks prove source behavior,
2. Electron checks prove the built application and sandboxed bridge,
3. native package smoke proves only the tested unsigned artifact and platform,
4. managed-install and source-runtime checks prove the exact runtime supplied,
5. live-provider checks require explicit authorization and prove only the
   selected profile and scenario,
6. signing, notarization, public-feed update, and cross-platform release
   acceptance remain separate gates.

## Use With

- [Source Tree Owner Map](source-tree-owner-map.md)
- [Code Quality Enforcement](code-quality-enforcement.md)
- [Testing And Validation](testing-and-validation.md)
- [API Compatibility](../API_COMPATIBILITY.md)

Apply the [comment and docstring review](../CODE_QUALITY.md#comment-and-docstring-review)
to the final diff, including tests and scripts.
