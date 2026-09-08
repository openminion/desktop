# OpenMinion Desktop Getting Started

Status: active
Last updated: 2026-09-07

Purpose: provide the package-local bootstrap and first-run path for the
OpenMinion Desktop source repository.

## Requirements

1. macOS for running the current application profile,
2. Node.js 24,
3. npm 11, and
4. a matching desktop-capable local OpenMinion checkout or executable.

Linux participates in provider-free CI, but Linux and Windows desktop packages
are not currently certified.

## Fast Bootstrap

From the Desktop repository root:

```bash
npm ci
npm run hooks:install
npm run ci-check
```

## First Run

To try every UI workflow before configuring OpenMinion, run:

```bash
npm run preview
```

The window is labeled **UI preview**. It uses sample tasks, attachments, files,
outputs, and screenshot images. Sending a message presents a sample approval;
allow, deny, or cancel it to exercise the turn controls. No daemon, model,
local files, or screen capture is accessed, and changes are discarded when
the window closes. This development fixture is excluded from packaged apps.

For the real application, use the following setup.

Configure OpenMinion with a nonblank `runtime.ipc_token`. If the intended
`openminion` executable is on `PATH`, start Desktop with:

```bash
npm start
```

Otherwise select it explicitly:

```bash
OPENMINION_ODF_EXECUTABLE=/path/to/openminion npm start
```

The executable must provide `openminion daemon desktop-bootstrap`. As of
2026-09-07, OpenMinion `main` does not contain that command; use the explicitly
matched desktop-capable development revision.

## Workspace Basics

You can write a local draft before the daemon connects. Creating a saved task,
attaching real context, and sending require the daemon connection. Draft text
is preserved when you connect and create the task.

Unsent text stays with its task when you switch between tasks during the same
app session. Creating another task starts with an empty composer. These local
drafts are not persisted after quitting the app. After sending, your message remains
visible while OpenMinion works, then the conversation refreshes from saved
history. Rejected submissions keep the text in the composer for correction.

Create a **New task** in the sidebar, then write your message. Use the send
button or **Command+Enter** on macOS (**Ctrl+Enter** elsewhere). Enter alone
adds a new line.

Type `/` or press **Command/Ctrl+K** to open Desktop commands. Arrow keys select,
Tab completes, and Enter runs a command. Start with `/help`, `/new`, `/sessions`,
`/status`, or `/cancel`. See [Desktop Commands and Focus Parity](commands.md)
for the supported commands and remaining integration work.

The **+** button beside the composer opens image and file attachments.
**Screenshot** opens the screen or window chooser beside your message.
Choose **Entire screen** or **Window**, select a source, and **Start preview**.
The composer shows the selected source and its local preview. Check
**Include screenshot**, write your instruction, and send: OpenMinion receives
one latest frame with that message, not a video stream. The checkbox resets
after sending. Pause, change, or stop the preview from **Screenshot**.

Preview stays local until you explicitly send it, ask for guidance, or enable
the advanced **Automatic watch**. Watch sends repeated screenshots and can
incur model costs; it is not continuous video or computer control.

**Context** contains local files and task outputs. Both option panels close
with Escape or an outside click; neither is a permanent side panel. See
[Screen Context](screen-context.md) for the current behavior and longer-term
design direction.

## Read First

1. [README.md](../README.md) explains the product boundary.
2. [Source Tree Owner Map](source-tree-owner-map.md) explains where changes
   belong.
3. [Testing And Validation](testing-and-validation.md) separates provider-free,
   package, native, and daemon proof.
4. [Security Policy](../SECURITY.md) explains the process and reporting
   boundaries.

## Permission Boundary

macOS may request Screen Recording permission when screen or window observation
is used. Denial must leave chat available and observation unavailable; it must
not grant partial capture authority.

Native input execution, remote daemon operation, and signed distribution remain
outside the current product profile.
