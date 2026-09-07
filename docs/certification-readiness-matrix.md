# Certification readiness

Status: development alpha

| Surface | Current evidence | Disposition |
| --- | --- | --- |
| Provider-free code quality | format, lint, type, tests, and build | ready for pull-request use |
| Development dependency audit | known Electron Forge transitive findings; no `node_modules` shipped | monitored through Dependabot; not a clean full audit |
| Linux source compatibility | provider-free CI | supported as a CI host, not a packaged product |
| macOS development app | local start, package smoke, and runtime-file allowlist | development-ready |
| macOS native capture | opt-in permissioned test | requires acceptance on an authorized host |
| OpenMinion daemon contract | explicit real-daemon test | requires a compatible daemon revision |
| Signed and notarized macOS app | no evidence | not ready |
| Update, rollback, migration, uninstall | no evidence | not ready |
| Windows and Linux packages | no evidence | not ready |
| Remote daemon operation | out of current local profile | not ready |
| Public release | release workflow intentionally absent | not ready |

Do not promote an unsigned package build into a release claim. Update this
matrix only when the matching exact test or release evidence exists.
