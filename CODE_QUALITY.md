# OpenMinion Desktop Code Quality and Hygiene

This is the public contributor version of the Desktop code-quality rules.

The short version:

1. keep ownership clear,
2. keep privileged behavior out of the renderer,
3. keep code explicit and readable,
4. keep changes focused, and
5. prove each changed boundary at the correct tier.

## 1. Prefer one truthful owner

Keep agent execution, sessions, policy, credentials, and durable state in
OpenMinion. Keep daemon lifecycle, file grants, capture, and operating-system
access in Electron main. Keep preload small, typed, and fixed-purpose. Keep
presentation and interaction state in the renderer.

Avoid duplicate state owners, pass-through wrappers, generic managers,
registries, retries, or fallback paths that do not enforce a current contract.

## 2. Keep privileged behavior structural

The renderer is untrusted. It must not gain Node.js, filesystem, credential,
shell, raw IPC, or generic network access. Validate data at renderer, preload,
daemon, file, and native-capture boundaries, then rely on typed values inside
the owning process.

Security-sensitive operations must remain bound to the session, source, grant,
frame, and lifecycle state required by their contract.

## 3. Code should explain itself

Use concrete names, strict types, and direct control flow. Keep comments short
and limited to non-obvious ownership, safety, or compatibility reasons. Do not
add abstractions in anticipation of a future product surface.

Paths should communicate ownership: the directory names the subsystem and the
file names its local role. Add a file only when it creates a clearer owner.

## 4. Keep generated and local data out of source

Do not commit `node_modules/`, `dist/`, `out/`, captured media, credentials, or
`.openminion` runtime state.

Package only built runtime files, license notices, and runtime metadata. Never
copy source, tests, hooks, CI, docs, development dependencies, credentials, or
local state into the application archive.

## 5. Keep changes focused

Use one clear purpose per pull request, update tests next to the changed owner,
and record unrelated cleanup separately. Do not turn a feature or fix into a
broad structural rewrite.

## 6. Validate before calling work done

Run the same provider-free gate used by CI:

```bash
npm run ci-check
```

It checks formatting, lint rules, TypeScript, the public repository surface,
tests, and the production build. The public-surface check keeps required files,
local links, portable paths, headings, lifecycle metadata, and documented npm
commands synchronized.

GitHub Actions also lints its workflow definitions, validates new commit
subjects, runs the normal package gate on Linux and macOS, and builds an
unsigned macOS package. A manual `packages` run stages unsigned macOS, Windows,
and Linux outputs in a private draft release for verification or transfer. The
repository uses small Node-native hooks rather than adding a Python pre-commit
runtime to this TypeScript application.

Run `npm run package` when packaging or runtime assets change. Native capture
and real-daemon tests remain explicit acceptance tiers because they require
macOS permissions or a compatible OpenMinion executable.

An unsigned package, skipped integration test, or provider-free check is not
evidence for signed distribution or live model behavior.
