# Contributing to OpenMinion Desktop

## Setup

Use Node.js 24 and npm 11.

```bash
npm ci
npm run hooks:install
```

Make focused changes, add or update tests, and run the package gate before opening
a pull request:

```bash
npm run ci-check
```

`npm run hooks:run` reproduces the local pre-commit checks and validates the
current commit subject. `npm run ci-check` is the stable provider-free command
used by GitHub Actions.

## Git workflow

Develop on `dev` or a focused branch based on `dev`. Merge reviewed and validated
changes into `main`.

Commit subjects use:

```text
<type>(<optional-scope>): <summary>
```

Allowed types are `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`, and
`build`.

## Optional integration checks

Run the native capture test on a macOS session that has the required screen-recording
permission:

```bash
npm run package
OPENMINION_ODC_NATIVE_CAPTURE=1 npm test -- tests/main/capture-native.test.ts
```

Run real daemon integration tests with a compatible OpenMinion executable:

```bash
OPENMINION_ODF_EXECUTABLE=/path/to/openminion npm test -- tests/main/index.test.ts
```

Do not add credentials, runtime data, captured media, or generated packages to Git.
See [CODE_QUALITY.md](./CODE_QUALITY.md) for the package boundary rules.
