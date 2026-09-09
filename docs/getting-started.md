# OpenMinion Desktop Getting Started

Status: active
Last updated: 2026-09-08

Purpose: provide the package-local bootstrap and first-run path for the
OpenMinion Desktop source repository.

## Requirements

1. macOS for running the current application profile,
2. Node.js 24,
3. npm 11, and
4. Python 3.11 for the current managed PyPI installation path.

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

Start Desktop with:

```bash
npm start
```

On first launch, Desktop creates a Python environment under its application data
directory, installs the pinned `openminion==0.0.18` PyPI package, initializes a
credential-free echo config, assigns an authenticated loopback daemon endpoint,
and starts the daemon. Later launches reuse the environment while its version
matches the pin.

For source development, bypass the managed installation with:

```bash
OPENMINION_EXECUTABLE=/path/to/openminion npm start
```

The executable must provide the ordinary `config init` and `daemon
start/status/stop` commands. No Desktop-specific OpenMinion command is required.

The real app supports text messages, saved history, task closing, and turn
cancellation through the ordinary CLI/API. New installations use the **echo demo
provider**, which repeats input without calling a model. Configure a real provider
through OpenMinion's existing configuration workflow; Desktop does not add a
provider or credential owner. Use `npm run preview` for sample approval, file,
artifact, and screen-context interactions that are not connected to PyPI yet.

## Workspace Basics

If the daemon stops while the window stays open, click the connection indicator
at the bottom of the sidebar. Opening its details checks the current connection;
use **Reconnect** when offered. Your unsent message stays in the composer.

With PyPI 0.0.18, **Cancel** requests cancellation, but an in-flight provider
request can still complete. Desktop displays the outcome reported by the daemon.

Text chat and completed conversation history work in the real app. Attachment
sending, artifact browsing, approval decisions, and automatic watch remain
preview-only; the connected app marks those integrations unavailable.

You can write a local draft before the daemon connects. Creating a task draft and sending require the daemon connection. A new task is
explicitly local until its first message creates the canonical saved session. Draft text
is preserved when you connect and create the task.

Unsent text stays with its task when you switch between tasks during the same
app session. Creating another task starts with an empty composer. These local
drafts are not persisted after quitting the app. After sending, your message remains
visible while OpenMinion works, then the conversation refreshes from saved
history. Rejected submissions keep the text in the composer for correction.

Write your first message and send it to create a task automatically. Use
**New task** in the sidebar to start another conversation. Use the send
button or **Enter** to send. **Shift+Enter** adds a new line.

Type `/` or press **Command/Ctrl+K** to open the command menu. Arrow keys select,
Tab completes, and Enter runs a command. Start with `/help`, `/new`, `/sessions`,
or `/status`. Use the **Cancel** button to stop a running turn.
Desktop is the GUI for Focus; command integration is currently incomplete.
See [Desktop Commands and Focus Parity](commands.md)
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
