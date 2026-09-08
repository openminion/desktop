# OpenMinion Desktop Engineering Patterns

Status: active
Last updated: 2026-09-07

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

1. OpenMinion owns agent semantics, sessions, policy, credentials, artifacts,
   and durable execution truth.
2. Electron main owns daemon supervision, authenticated communication, file
   grants, capture, protocols, and operating-system access.
3. Preload owns the narrow typed bridge and exact validation of renderer-visible
   values.
4. The renderer owns presentation, navigation, interaction state, and visible
   capture controls.
5. Shared modules own contracts used across more than one Desktop process.

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

## Readability Rules

Use concrete names and direct control flow. Keep comments short and limited to
non-obvious ownership, safety, or compatibility reasons. Paths should name the
subsystem and local role. Add a file only when it creates a clearer owner.

Keep generated builds, captured media, runtime state, credentials, and local
integration artifacts out of Git.

## Use With

- [Source Tree Owner Map](source-tree-owner-map.md)
- [Code Quality Enforcement](code-quality-enforcement.md)
- [Testing And Validation](testing-and-validation.md)
- [API Compatibility](../API_COMPATIBILITY.md)
