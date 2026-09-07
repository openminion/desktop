# Code-quality enforcement

## Applicability matrix

| Family gate | Desktop disposition |
| --- | --- |
| Supported language/runtime versions | apply: `.nvmrc`, package engines, Node.js 24 types, and lockfile pin Node.js 24 and npm 11 |
| Package-owned normal CI command | apply: `npm run ci-check` |
| Formatting and lint | apply: Biome |
| Static typing | apply: TypeScript strict mode |
| Unit and contract tests | apply: Vitest |
| Commit-message policy | apply: local hook and hosted changed-range validation |
| Cross-platform checks | package-specific: Linux and macOS provider-free checks; macOS package smoke |
| Packaged-file boundary | apply: final `app.asar` runtime allowlist verification |
| Native permission checks | package-specific: explicit macOS opt-in test |
| OpenMinion integration | package-specific: explicit compatible-daemon test |
| Python pre-commit and validators | not applicable: this is a Node/TypeScript application |
| Numeric debt baselines | not applicable: current TypeScript and Biome gates are clean |
| Release publishing | not applicable until signing, notarization, update, and rollback are implemented |
| Windows and Linux packaging | not applicable until those platforms are accepted and certified |

## Enforcement layers

Local hooks run formatting, lint, and type checks before a commit and validate
the subject at commit time. `npm run hooks:run` checks the same policy against
the current revision. GitHub Actions validates new commit subjects, runs the
complete package check on Linux and macOS, and builds an unsigned macOS package.

The normal CI command is deliberately package-owned. Workflow steps and local
documentation call it instead of duplicating its internal sequence.
