# OpenMinion Desktop Code Quality Enforcement

Status: active
Last updated: 2026-09-07

Purpose: summarize the public contributor view of Desktop's local hooks,
package-owned checks, hosted CI, and explicit acceptance tiers.

## What Contributors Should Expect

Desktop enforces quality through:

1. explicit daemon, main, preload, renderer, and shared-contract ownership,
2. package-owned formatting, lint, type, test, build, and public-surface checks,
3. local pre-commit and commit-message hooks,
4. hosted Linux and macOS checks plus workflow lint, and
5. separate permissioned native-capture and real-daemon acceptance tiers.

## Required Local Validation

Run:

```bash
npm run ci-check
npm run hooks:run
```

Run `npm run package` when packaging, runtime assets, Forge configuration, or
the packaged-file boundary changes.

## Applicability Matrix

| Family gate | Desktop disposition |
| --- | --- |
| Supported language/runtime versions | apply: `.nvmrc`, package engines, Node.js 24 types, and lockfile pin Node.js 24 and npm 11 |
| Package-owned normal CI command | apply: `npm run ci-check` |
| Formatting and lint | apply: Biome |
| Static typing | apply: TypeScript strict mode |
| Unit and contract tests | apply: Vitest |
| Public repository surface | apply: Node-native required-file, local-link, portable-path, heading, lifecycle-metadata, and documented-command validation |
| GitHub Actions syntax and semantics | apply: actionlint in hosted CI |
| Commit-message policy | apply: local hook and hosted changed-range validation |
| Cross-platform checks | package-specific: Linux and macOS provider-free checks; macOS package smoke |
| Packaged-file boundary | apply: final `app.asar` runtime allowlist verification |
| Native permission checks | package-specific: explicit macOS opt-in test |
| OpenMinion integration | package-specific: explicit compatible-daemon test |
| Python Make, pre-commit, and validators | not applicable: this is a Node/TypeScript application |
| Numeric debt baselines | not applicable: current TypeScript and Biome gates are clean |
| Release publishing | not applicable until signing, notarization, update, and rollback are implemented |
| Windows and Linux packaging | not applicable until those platforms are accepted and certified |

## Enforcement Layers

Local hooks run formatting, lint, type, and public-surface checks before a
commit, then validate the subject at commit time. `npm run hooks:run` checks the
same policy against the current revision.

GitHub Actions validates workflow definitions and new commit subjects, runs the
complete package check on Linux and macOS, and builds an unsigned macOS package.
Workflow steps call stable package scripts instead of duplicating their
internal sequences.

## What The Gates Protect

The checks protect source readability, process authority, typed contracts,
public documentation, packaged-file contents, and compatibility claims. They
do not replace permissioned native testing, live daemon integration, signing,
notarization, or release acceptance.

## See Also

- [Engineering Patterns](engineering-patterns.md)
- [Testing And Validation](testing-and-validation.md)
- [Source Tree Owner Map](source-tree-owner-map.md)
- [Code Quality and Hygiene](../CODE_QUALITY.md)
