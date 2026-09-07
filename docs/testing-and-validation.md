# OpenMinion Desktop Testing And Validation

Status: active
Last updated: 2026-09-07

Purpose: define the separate validation tiers for source quality, unsigned
packaging, native capture, and real OpenMinion daemon integration.

## Install Baseline

Desktop expects Node.js 24 and npm 11. Install the exact locked dependency set:

```bash
npm ci
```

## Normal Package Gate

```bash
npm run ci-check
```

This checks formatting, Biome lint, strict TypeScript, required public files,
documentation links, headings, lifecycle metadata and commands, the
provider-free Vitest suite, and the production build.

Run local hook parity separately:

```bash
npm run hooks:run
```

Hosted CI also runs actionlint against `.github/workflows/`.

## macOS Package Smoke

```bash
npm run package
```

This produces an unsigned development application. It does not prove signing,
notarization, installation, updating, rollback, or release readiness.

The command rejects an application archive containing repository-only files,
development dependencies, local `.openminion` state, source, or tests.

## Native Capture

Run from a macOS session with Screen Recording permission:

```bash
OPENMINION_ODC_NATIVE_CAPTURE=1 npm test -- tests/main/capture-native.test.ts
```

## Real Daemon Integration

```bash
OPENMINION_ODF_EXECUTABLE=/path/to/openminion \
  npm test -- tests/main/index.test.ts
```

Use an OpenMinion revision that implements the Desktop bootstrap contract. As
of 2026-09-07, OpenMinion `main` does not contain that command, so the
integration tier requires a matching desktop-capable development revision.

## Proof Boundary

Provider-free tests, unsigned packaging, native capture, real-daemon
integration, provider-backed behavior, and signed release acceptance are
different proof tiers. Do not present one tier as evidence for another.
