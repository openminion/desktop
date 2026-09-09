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
in **Settings → Agent profiles**, using your existing OpenMinion profile JSON. Use `npm run preview` for sample approval, file,
artifact, and screen-context interactions that are not connected to PyPI yet.

## Agent Profiles and Keys

Click **Settings** above the connection indicator in the sidebar.

1. Use **Import profiles…** to choose an existing Focus/CLI profile JSON file.
   Import adds agents and replaces matching agent IDs. It keeps Desktop's
   connection, storage, and other profiles in place.
2. Choose an agent to edit its model, provider URL, or model API
   key. The provider adapter comes from the imported profile; MiniMax uses the
   OpenAI-compatible adapter with the MiniMax endpoint.
3. Choose **Use this agent for new tasks** to change the default. Existing
   conversations retain their agent.
4. Expand **Search and web tool keys** to set Brave, SerpAPI, Serper, Tavily,
   Firecrawl, or TinyFish credentials. These keys are shared across agents and
   are separate from the model credential.
5. Finish running Desktop chats, then click **Save and apply**. Desktop checks
   the config using the installed OpenMinion CLI and restarts the daemon. If
   reconnection fails, the app reports that settings were saved but not applied.

Stored keys are never returned to the form. **Set** means a key is present,
not that the provider has accepted it or has available quota. Leave a key blank
to keep it, enter a replacement, or select **Remove saved key**. Changes to the
model key apply to the selected agent. Keys supplied externally by the launch
environment must be removed there.

Import uses the existing OpenMinion JSON shape. It imports agent definitions,
their provider configuration, environment entries ending in `_API_KEY`, the
profile's brain limits for elapsed time, ticks, LLM tokens and tool calls, and
`OPENMINION_WEB_SEARCH_PROVIDER`. It does not import daemon addresses, access
tokens, storage paths, or arbitrary process environment settings. YAML imports,
creating profiles from templates, and editing prompts or policy are not yet in
this form; use the existing Focus/CLI configuration workflow for those fields.
The pinned PyPI runtime uses agent names as identities, so imported `name` values
must match their agent IDs. Settings preserves those names when editing a model
or key.

Settings are written to the private local OpenMinion config, with a private
`.backup` copy of the previous config. They are not a separate Desktop profile
format. Close discards unsaved edits, and changing the selected agent discards
unsaved fields for that agent. Your conversations remain saved when settings
are applied.

## Workspace Basics

If the daemon stops while the window stays open, click the connection indicator
at the bottom of the sidebar. Opening its details checks the current connection;
use **Reconnect** when offered. Your unsent message stays in the composer.

With PyPI 0.0.18, **Stop** requests cancellation, but an in-flight provider
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

Assistant replies show the reported profile beside **OpenMinion**. Desktop moves
a matching speaker prefix out of the displayed answer and copied reply; saved
transcripts remain unchanged. Progress uses a subtle working indicator, while
successful completion leaves the composer quiet. Stop requests and errors remain
visible; a stop request is not treated as confirmed cancellation.
While a reply is running, an elapsed-time counter shows how long you have waited,
and Stop replaces the send arrow. You can keep drafting. Stop stays pending until
OpenMinion reports the outcome. The status area keeps its place when a reply ends,
and history refreshes without clearing the conversation.

Type `/` or press **Command/Ctrl+K** to open the command menu. Arrow keys select,
Tab completes, and Enter runs a command. Start with `/help`, `/new`, `/sessions`,
or `/status`. Use the **Stop** button to stop a running turn.
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
