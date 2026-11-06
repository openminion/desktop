- Describe the user-visible or repository outcome.
- Note any affected ownership, compatibility, or evidence boundary.

Validation
- `npm run ci-check` — result
- Add exact package, native, or daemon checks required by the change, with results.

<!-- Target dev for feature work. Keep unverified or skipped evidence explicit. -->

Quality review

- [ ] Reviewed the full final diff and every delta against the [code-quality rules](https://github.com/openminion/desktop/blob/dev/CODE_QUALITY.md#minimum-usable-code), with exact-head caller/failure evidence and no unresolved findings.
- [ ] Removed speculative layers, redundant defenses and comment narration while preserving required contracts and rationale.
- [ ] For cleanup, recorded inventory, per-file outcomes and remaining work; for historical findings, verified surviving code and existing ownership.
