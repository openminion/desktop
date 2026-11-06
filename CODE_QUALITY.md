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
copy source, tests, hooks, CI, docs, dependency directories, credentials, or
local state into the application archive. Selected runtime dependencies are
bundled into the reviewed build output; their presence in `devDependencies`
does not mean they are absent from the shipped JavaScript.

## 5. Keep changes focused

Use one clear purpose per pull request, update tests next to the changed owner,
and record unrelated cleanup separately. Do not turn a feature or fix into a
broad structural rewrite.

Before editing, inspect the working tree and identify the files you own. After
editing, review that changed-file set for duplicate logic, unnecessary wrappers,
unused paths, and documentation that depends on a contributor's local checkout.
A bounded review is not a claim that the whole package has been cleaned.

A broad cleanup needs a fresh file inventory and a disposition for every file
in scope: keep, simplify, or defer with a reason and existing owner. Keep source,
test, and script inventories separate, record validation, and refresh them if
the checkout moves. Keep scratch inventories outside the tracked package.
Small fixes do not need a new tracker; record their scope and proof in the PR.

Prefer direct code and remove indirection only when it improves readability.
Preserve authorization, typed boundaries, cancellation, timeouts, persistence,
and accessibility contracts. Use the [focused validation loop](docs/testing-and-validation.md#focused-iteration),
then run the applicable package and integration gates below.

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
unsigned macOS package. A maintainer `packages` run on canonical `main` stages unsigned macOS, Windows,
and Linux outputs in a draft release for verification or transfer. Reviewed
unsigned development distribution follows [Releasing](RELEASING.md). The
repository uses small Node-native hooks rather than adding a Python pre-commit
runtime to this TypeScript application.

Run `npm run package` when packaging or runtime assets change. Native capture
and real-daemon tests remain explicit acceptance tiers because they require
macOS permissions or a compatible OpenMinion executable.

An unsigned package, skipped integration test, or provider-free check is not
evidence for signed distribution or live model behavior.

## Comment and docstring review

This rule applies to every contributor and coding agent, including tests and
scripts. Let clear names, types and direct control flow explain ordinary steps.
Review every added or changed comment and docstring in the final diff; remove
obvious restatements, decorative banners and duplicated walkthroughs. Keep one
concise explanation at the owner when a constraint is not obvious.

Preserve public API and model-facing descriptions, required notices/directives,
and useful safety, compatibility and regression-oracle rationale. Keep short
factual module explainers; move longer design/history narratives to docs.
Passing automated checks does not replace this review, and there is no comment
quota. Check current source and existing reports before filing cleanup debt;
keep unrelated cleanup out of a feature PR.

## Minimum usable code

These rules apply to maintainers, external contributors and coding agents, in
new work and cleanup of merged code. Start with actual callers, supported inputs
and concrete failure paths. Use the existing owner and a direct implementation;
add a helper or abstraction only when current callers need it.

Do not add speculative frameworks, unused modes or extension points,
pass-through wrappers, duplicate validation, silent defaults, blanket exception
handling, or retries that hide failures. Validate at the boundary that owns the
contract instead of repeatedly normalizing internal values. A retry needs a
specific transient failure, a bound and safe repeat behavior. Preserve necessary
trust-boundary checks, permissions, compatibility, persistence/replay and cleanup.

Renderer input remains untrusted. Keep validation and permissions at the
main/preload boundary, and preserve daemon authority and native resource cleanup.

## Review and cleanup evidence

Review the complete final diff and every new delta for simplicity and the
[comment and docstring rules](#comment-and-docstring-review). Record the exact
reviewed head, checked callers, supported failure cases, findings and disposition
in the PR or linked review evidence. Passing automated checks does not replace
this review. Block approval or merge while a substantiated finding remains;
request the smaller existing-owner change when it satisfies the same contract.
Validate the current integration with the target branch and require all required
hosted checks on the exact head before merging. Never relax a gate to land cleanup.

For merged work, first verify that the code still exists on the current
development branch. Reuse existing findings and respect active ownership; record
obsolete findings without reopening old PRs, duplicating issues or taking over
another contributor's branch. Do not label all historical code clean from a
partial review.

A broad cleanup starts with a fresh file inventory at a recorded revision. Keep
source, tests and scripts separate, give each claimed file a trim, keep or explicit
defer disposition, and work in bounded tranches. Record callers, rationale,
validation and remaining work after each tranche; deferred files remain open.
Refresh evidence if the tree changes during validation. Record before/after LOC
for source cleanup and retain a simplification only when it reduces code and
improves readability while preserving the contract. Review the changed files
again after authoring; this is not proof of a package-wide sweep.

Preserve test assertions and negative controls. Do not introduce skips, expected
failures, extra waits or retries to conceal a regression. Preserve script output,
exit behavior and operator clarity. Run the repository's documented gates and
report local, hosted, installed-package and live-system evidence separately.
