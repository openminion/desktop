# OpenMinion Desktop Code Quality and Hygiene

OpenMinion Desktop keeps its quality rules small and package-owned.

## Core rules

1. Keep the OpenMinion daemon as the agent, session, and policy owner.
2. Keep privileged Electron behavior in main. The renderer must not gain Node.js,
   filesystem, credential, shell, raw IPC, or generic network access.
3. Prefer direct code and concrete owners over wrappers, managers, registries, or
   fallback paths that do not enforce a current contract.
4. Validate data at renderer, preload, daemon, file, and native-capture boundaries.
   Do not repeat validation inside already typed owner-controlled paths.
5. Add focused tests for every changed public contract or security boundary.
6. Keep generated `node_modules/`, `dist/`, and `out/` content out of Git.
7. Package only built runtime files, license notices, and runtime metadata. Never
   copy source, tests, hooks, CI, docs, local state, or `.openminion` into the app.

## Required validation

Run the same gate used by CI:

```bash
npm run ci-check
```

It checks formatting, lint rules, TypeScript, tests, and the production build.
Use `npm run format` only when formatting changes are intended.

GitHub Actions also validates every new commit subject and builds an unsigned
macOS package. The repository uses small Node-native hooks rather than adding a
Python pre-commit runtime to this TypeScript application.

The package command verifies the final `app.asar` allowlist after Forge builds
it, so local-state or repository-file leakage fails the package gate.

The native capture and real daemon tests remain explicit platform and integration
checks because they require macOS permissions or a compatible OpenMinion executable.
