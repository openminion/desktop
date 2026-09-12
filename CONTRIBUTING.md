# Contributing to OpenMinion Desktop

Thanks for contributing.

## Before coding

Read these package-local references first:

1. [Engineering Patterns](docs/engineering-patterns.md)
2. [Code Quality Enforcement](docs/code-quality-enforcement.md)
3. [Getting Started](docs/getting-started.md)
4. [OpenMinion Desktop Code Quality and Hygiene](CODE_QUALITY.md)
5. [Testing and Validation](docs/testing-and-validation.md)
6. [API Compatibility](API_COMPATIBILITY.md)

Keep the process boundary explicit: OpenMinion owns agent execution, sessions,
policy, credentials, and durable state; Desktop main owns privileged local
integration; preload owns the narrow typed bridge; and the renderer owns
presentation and interaction state.

## Quick start

Use Node.js 24 and npm 11.

```bash
npm ci
npm run hooks:install
npm run ci-check
```

## Development basics

1. Make focused, reviewable changes.
2. Prefer one direct owner over new wrappers, managers, registries, or fallback
   paths without a present contract.
3. Add or update focused tests for behavior and boundary changes.
4. Keep credentials, runtime data, captured media, generated packages,
   `node_modules/`, `dist/`, and `out/` out of Git.
5. Include the exact validation commands and results in the pull request.
6. Do not mix unrelated refactors into a feature or fix.

`npm run hooks:run` reproduces the local pre-commit checks and validates the
current commit subject. `npm run ci-check` is the stable provider-free command
used by GitHub Actions. Both paths verify the public documentation surface as
well as source formatting, lint, and types.

Preferred pull-request shape:

```text
Short GitHub-native title

- user-visible or repository outcome
- important boundary or compatibility detail

Validation
- npm run ci-check
- other exact proof required by the changed surface
```

## Git workflow

Develop on `dev` or a focused branch based on `dev`. Merge reviewed and
validated changes into `main`.

Commit subjects use:

```text
<type>(<optional-scope>): <summary>
```

Allowed types are `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`,
and `build`. Prefer a scope that names the affected owner, such as `main`,
`preload`, `renderer`, `protocol`, `capture`, or `ci`.

## Optional integration checks

Run the native capture test on a macOS session with Screen Recording
permission:

```bash
npm run package
OPENMINION_ODC_NATIVE_CAPTURE=1 npm test -- tests/main/capture-native.test.ts
```

Run the real managed-runtime and pinned-package integration checks:

```bash
env -u OPENMINION_EXECUTABLE -u OPENMINION_PYPI_EXECUTABLE \
  node tests/electron/managed-install.mjs
OPENMINION_PYPI_EXECUTABLE=/path/to/openminion npm test -- tests/main/cli-client.test.ts
OPENMINION_PYPI_EXECUTABLE=/path/to/openminion npx electron tests/electron/pypi.mjs
```

These checks prove different tiers. An unsigned package does not prove native
permission behavior, and a provider-free test does not prove a live daemon or
model-backed workflow.

## Legal basics

1. You keep ownership of your contributions.
2. By submitting a contribution, you license it under Apache-2.0.
3. Only submit code and content you have the right to contribute.
4. Document compatible licenses for third-party code or assets.
5. Project names and logos are not granted for endorsement use.
6. OpenMinion Desktop is provided on an "as is" basis under the project
   license.
7. You are responsible for charges from third-party providers or infrastructure
   used during development or testing.
8. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for the governing terms.

## Security

Do not open a public issue containing exploit details. Follow
[SECURITY.md](SECURITY.md).

## Code of conduct

By participating, you agree to follow
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
