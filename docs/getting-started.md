# Getting started

## Requirements

- macOS for running the current application profile
- Node.js 24
- npm 11
- a compatible local OpenMinion checkout or executable

## Setup and validation

```bash
npm ci
npm run hooks:install
npm run ci-check
```

Configure OpenMinion with a nonblank `runtime.ipc_token`. If the intended
executable is not already on `PATH`, set `OPENMINION_ODF_EXECUTABLE` to it, then
start the app:

```bash
npm start
```

macOS may request Screen Recording permission when screen or window observation
is used. Denial should leave chat available and observation unavailable; it must
not grant partial capture authority.
