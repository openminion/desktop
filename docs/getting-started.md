# OpenMinion Desktop Getting Started

Status: active
Last updated: 2026-09-07

Purpose: provide the package-local bootstrap and first-run path for the
OpenMinion Desktop source repository.

## Requirements

1. macOS for running the current application profile,
2. Node.js 24,
3. npm 11, and
4. a matching desktop-capable local OpenMinion checkout or executable.

Linux participates in provider-free CI, but Linux and Windows desktop packages
are not currently certified.

## Fast Bootstrap

From the Desktop repository root:

```bash
npm ci
npm run hooks:install
npm run ci-check
```

## First Run

Configure OpenMinion with a nonblank `runtime.ipc_token`. If the intended
`openminion` executable is on `PATH`, start Desktop with:

```bash
npm start
```

Otherwise select it explicitly:

```bash
OPENMINION_ODF_EXECUTABLE=/path/to/openminion npm start
```

The executable must provide `openminion daemon desktop-bootstrap`. As of
2026-09-07, OpenMinion `main` does not contain that command; use the explicitly
matched desktop-capable development revision.

## Read First

1. [README.md](../README.md) explains the product boundary.
2. [Source Tree Owner Map](source-tree-owner-map.md) explains where changes
   belong.
3. [Testing And Validation](testing-and-validation.md) separates provider-free,
   package, native, and daemon proof.
4. [Security Policy](../SECURITY.md) explains the process and reporting
   boundaries.

## Permission Boundary

macOS may request Screen Recording permission when screen or window observation
is used. Denial must leave chat available and observation unavailable; it must
not grant partial capture authority.

Native input execution, remote daemon operation, and signed distribution remain
outside the current product profile.
