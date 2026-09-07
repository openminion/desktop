## Summary

- Describe the user-visible or repository outcome.

## Validation

- [ ] `npm run ci-check`
- [ ] `npm run package` when packaging or runtime assets changed
- [ ] Native capture or real-daemon integration when the affected boundary requires it

## Boundaries

- [ ] The daemon remains authoritative for agent, session, policy, and credential state
- [ ] Renderer authority remains limited to the reviewed preload contract
- [ ] User-facing claims match the evidence in this change
