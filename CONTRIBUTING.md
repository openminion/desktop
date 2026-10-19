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
7. [Source Tree Owner Map](docs/source-tree-owner-map.md)

Keep the process boundary explicit: OpenMinion owns agent execution, sessions,
policy, credentials, and durable state; Desktop main owns privileged local
integration; preload owns the narrow typed bridge; and the renderer owns
presentation and interaction state.

## Choose a contribution

Search existing issues before opening a new one. Use the
[bug report template](.github/ISSUE_TEMPLATE/bug-report.md) for reproducible
problems or the [feature request template](.github/ISSUE_TEMPLATE/feature-request.md)
for a missing workflow. For CLI/Focus parity, include the existing command and
its expected effect. A documentation or usability fix is welcome without a new
architecture proposal. Discuss a larger change before investing in it.

Security reports follow [SECURITY.md](SECURITY.md), not the public issue templates.

## Quick start

Use Node.js 24 and npm 11. Provider-free source checks need no model credentials;
Python 3.11 is needed when starting the managed OpenMinion runtime.

Fork the public repository, then clone your fork. Maintainers can use the
upstream checkout instead. For a fork, replace `YOUR-ACCOUNT` and choose a
purpose-named branch:

```bash
git clone https://github.com/YOUR-ACCOUNT/desktop.git
cd desktop
git remote add upstream https://github.com/openminion/desktop.git
git fetch upstream dev
git worktree add ../desktop-change -b fix/short-description upstream/dev
cd ../desktop-change
npm ci
npm run hooks:install
npm run ci-check
```

The primary checkout stays untouched. Push the feature branch to your fork’s
`origin` and open a PR against `openminion/desktop:dev`. Maintainers using the
upstream checkout use `origin/dev` as the worktree starting point instead.
Before final validation, fetch the upstream `dev` branch again and reconcile
any new changes. Do not use a check from an earlier revision as final proof.

## Iterating on a change

Start with the closest existing tests while editing, then run the full package
gate before review. The [focused validation loop](docs/testing-and-validation.md#focused-iteration)
includes commands for a single test file and fixing formatting failures.

For cleanup, use the [bounded review guidance](CODE_QUALITY.md#5-keep-changes-focused).
A small fix does not need a new process document or a package-wide refactor.

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

1. Start from current upstream `dev` in an isolated worktree on a local feature
   branch. Keep unrelated work intact.
2. Publish a purpose-named `feat/*`, `fix/*`, `docs/*`, `refactor/*`, `test/*`,
   or `build/*` branch to your fork (or the upstream repository for maintainers).
   Do not publish `codex/*` branches.
3. Open the pull request against `dev`. Reconcile with current upstream `dev`,
   rerun the affected checks, and request review before merging.
4. Wait for both **Quality (ubuntu-latest)** and **Quality (macos-latest)** and
   any other configured checks to pass. Record skipped or external evidence
   honestly; a green provider-free check does not prove live provider behavior.
5. After merge, verify the delivered commit is in upstream `dev`, then remove
   the feature branch and its worktree.

Normal feature PRs do not target `main`. Maintainers promote reviewed `dev` to
`main` through [Releasing](RELEASING.md); runtime-certification evidence follows
its separate, documented release review. This is the same feature-to-`dev`,
reviewed-promotion boundary used by OpenMinion CLI.

Commit subjects use:

```text
<type>(<optional-scope>): <summary>
```

Allowed types are `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`,
and `build`. Prefer a scope that names the affected owner, such as `main`,
`preload`, `renderer`, `protocol`, `capture`, or `ci`.

## Optional integration checks

Build and inspect the current host's unsigned artifacts when packaging, runtime
assets, or Forge configuration changes:

```bash
npm run make
```

Run the native capture test on a macOS session with Screen Recording permission:

```bash
OPENMINION_ODC_NATIVE_CAPTURE=1 npm test -- tests/main/capture-native.test.ts
```

Run the real managed-runtime and pinned-package integration checks after building:

```bash
npm run build
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
