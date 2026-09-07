# Testing and validation

## Normal package gate

```bash
npm ci
npm run ci-check
```

This checks formatting, Biome lint, strict TypeScript, the provider-free Vitest
suite, and the production build. Run local hook parity separately with:

```bash
npm run hooks:run
```

## macOS package smoke

```bash
npm run package
```

This produces an unsigned development package. It does not prove signing,
notarization, installation, updating, rollback, or release readiness.
The command also rejects any app archive that contains repository-only files,
development dependencies, local `.openminion` state, source, or tests.

## Native capture

Run from a macOS session with Screen Recording permission:

```bash
OPENMINION_ODC_NATIVE_CAPTURE=1 npm test -- tests/main/capture-native.test.ts
```

## Real daemon integration

```bash
OPENMINION_ODF_EXECUTABLE=/path/to/openminion \
  npm test -- tests/main/index.test.ts
```

This must use an OpenMinion revision that implements the desktop bootstrap
contract. Provider-backed model behavior remains a separate acceptance tier.
