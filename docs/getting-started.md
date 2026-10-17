# OpenMinion Desktop Getting Started

Status: active
Last updated: 2026-10-17

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

To explore sample UI workflows before configuring OpenMinion, run:

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

On first launch, Desktop creates a Python environment under `~/.openminion/desktop/runtime`, installs the pinned OpenMinion PyPI package, initializes a
credential-free echo config, assigns an authenticated loopback daemon endpoint,
and starts the daemon. Later launches reuse the environment while its version
matches the pin.

The real app supports text messages, saved history, task closing, and turn
cancellation through the ordinary CLI/API. New installations open **Welcome to
OpenMinion**. Choose a provider, enter its model and API key, and click **Set up
and start**, or import an existing profile. Provider choices and defaults come
from the installed CLI's setup command. **Try echo demo** repeats input without
calling a model; setup appears again on the next launch until a real profile is
configured. **Test connection before continuing** is selected by default and
sends one provider request, which may use provider resources. Clear it to save
without testing; Desktop reports either **Connection verified** or **Connection
not tested** after setup. File, artifact, and screen-context sending remain
preview-only; request-bound approvals are connected on compatible runtimes.

## Runtime Updates

Open **Settings → Runtime** and choose **Python package** or **Native runtime** under
**Update options**, then use **Check updates**. When a certified compatible
record is available, **Prepare update** stages it separately; quit
and reopen Desktop to activate it before daemon startup. Binary records contain
separately verified `openminion` and `openminiond` executables from one immutable
runtime Release. Checks also run at startup and every 24 hours, without
installing automatically. Selecting a source changes only future checks and
does not relabel the active runtime. An empty binary feed cannot offer an
update. Missing or uncertified records do not authorize installation.

Desktop reads the `pypi` and `binary` stable feeds under
`releases/runtime/v1/` from the public OpenMinion repo's `main` branch, not
`dev` or a separate manifest branch.
Release publication prepares a metadata PR; protected merge makes its feed
discoverable. Records with no certified Desktop compatibility are skipped.
The main-to-dev back-merge keeps development metadata synchronized; it is not
another update channel and never upgrades a running app.

### Hold And Pin Runtime Upgrades

Expand **Update options** in **Settings → Runtime** for source selection,
**Pause upgrades**, **Resume upgrades**, **Pin installed runtime**,
**Set version pin**, **Remove pin**, and
**Discard prepared update**. A pause survives quit/reopen and blocks both
preparation and startup activation, including an already-prepared update.
Checks can still report availability while paused. Resume removes the pause,
not the pin; remove a pin separately to return to latest-compatible discovery.

A version pin resolves an exact compatible stable record from the public feed
and binds its source, immutable record URL and artifact SHA-256. Missing,
withdrawn, uncertified or older-than-installed targets are rejected without
fallback. Pinning does not install anything; check and explicitly prepare the
selected update afterwards. Pinning the installed runtime requires an existing
verified managed artifact identity; legacy installations can be paused or use
the developer executable override instead.

Discard cancels in-flight preparation or clears the pending candidate before
launch, never the active executable or conversations. Completed candidate files
are retained; this action is not a filesystem cleanup or data rollback.
After durable launch intent exists, policy edits/discard require recovery
review. An incompatible active runtime remains incompatible while paused or
pinned; these controls never bypass compatibility or downgrade protection.

Desktop never stops an external or replaced daemon to apply an update. A
recovery-required message means candidate launch began but did not complete;
do not downgrade the runtime against those data roots without review.

## Use A Source Runtime

For source development, use your existing source-installed executable and a
separate Desktop data root. From the Desktop repository root:

```bash
OPENMINION_DESKTOP_HOME=/absolute/path/to/desktop-dev \
  OPENMINION_EXECUTABLE=/absolute/path/to/venv/bin/openminion npm start
```

The executable override is unmanaged: Desktop does not install it with pip,
replace it, check manifests for it, or prepare/activate managed updates. You
update that source environment yourself. The data-root override keeps test
profiles, conversations and runtime policy separate from your normal Desktop
installation; selecting an executable alone does not isolate those files. Do
not use an executable override to recover or downgrade an interrupted managed
upgrade against its existing data roots.

The executable must provide the ordinary `config init` and `daemon status`
commands, with a sibling public `openminiond` entrypoint for an app-owned
foreground launch. A pre-existing daemon can be used but is not stopped by
Desktop; profile writes are rejected without verified app ownership. No
Desktop-specific OpenMinion command is required.

On Windows, select the source environment's `Scripts/openminion.exe`, with
`openminiond.exe` in the same directory, and set both environment variables in
your shell before `npm start`.

## Find A Conversation

Use **Search…** in the sidebar to filter loaded conversations by their displayed
name or session ID. Matching ignores case and treats punctuation literally.
Clear the field or press Escape to restore the list. Filtering keeps the current
conversation and draft open, even when that conversation is hidden. It does not search
message contents, and the query is not saved when Desktop closes.

## Desktop Data

New installations use the same location from source and from a packaged app:

```text
~/.openminion/desktop/
  desktop.sqlite    Chat names, unsent drafts, preferences and installation paths
  browser/          Electron browser state and cache
  logs/             Application logs
  runtime/          Managed Python environment
  agents.json       Core-managed agent profiles and credentials
  agents.json.backup Previous config retained when profiles are updated
  data/             Core-managed conversations and runtime state
```

The database contains local draft identities, unsent text, and presentation
metadata such as the quiet/normal/verbose tool display preference. Configured
provider credentials and canonical conversation transcripts are stored separately;
unsent drafts contain the text you type, which can itself include sensitive data.
OpenMinion owns the separate `data/` and `agents.json` contents under Desktop's directory;
the ordinary CLI's data remains separate. SQLite schema versions support
ordered migrations. An app that finds a newer schema refuses to open it and
asks for a compatible version; it never resets existing data. Replacing the
application bundle preserves this directory.
Unsigned development packages exist for all three platforms. Signing, Desktop
self-updates, and Windows/Linux runtime certification remain pending.

Existing installations keep their runtime and browser files in their previous
Electron application-data directory (on macOS, normally
`~/Library/Application Support/OpenMinion`). Desktop records and reuses those
paths in the new database. It does not relocate Python environments or rewrite
profiles. Browser-stored chat names import into SQLite on first use and are
removed from browser storage only after success. The recorded import prevents
leftover browser keys from restoring names that were subsequently reset.

Quit Desktop completely before backing up its data. Copy the Desktop directory
and, for an adopted installation, its previous application-data directory as
well. Restore them to their original locations on the same machine. Removing
just the application leaves user data intact; deleting these data directories
also removes saved profiles and conversations. Database-only backups contain
chat labels, preferences and unsent drafts, not canonical conversations or
configured provider credentials.

For an isolated development or test installation, set `OPENMINION_DESKTOP_HOME`
to an absolute directory. This overrides the root and skips automatic adoption
of the normal installation. `OPENMINION_EXECUTABLE` selects the executable only;
it does not select the data directory. A second launch using the same Desktop
root focuses the existing app instead of starting another managed daemon.

## Privacy and Connections

Desktop communicates with its daemon on an authenticated local endpoint. The
runtime can still contact external services:

| Action | Connection and data boundary |
| --- | --- |
| Install the managed runtime | Python's package installer downloads OpenMinion and dependencies; its configured package index applies. |
| Check runtime updates | Desktop requests public release metadata from GitHub at startup, every 24 hours, and when you choose **Check updates**. These requests do not include your chat or profile contents. |
| Prepare an update | Desktop downloads the selected eligible runtime artifacts. **Pause upgrades** blocks preparation and activation, but does not disable metadata checks. |
| Test a provider or send a message | OpenMinion uses the selected profile and tools. Configured providers and external tools may receive prompts, conversation context, queries, and tool inputs. Their data handling and charges apply. |
| Open a link in a reply | The link opens in your system browser, which contacts the destination site. |

The echo demo does not call a model, but runtime installation and update checks
can still use the network. Screen preview stays local in the current app; see
[Screen Context](screen-context.md) for its permission and integration limits.

Desktop does not encrypt its SQLite database or profile files, or put saved
profile keys in an operating-system credential vault. File permissions limit
access where supported. Both `agents.json` and its `.backup` can contain keys;
removing a key from the active profile does not erase earlier backups or copies.
Protect the whole data directory and any backups as sensitive files. See
[Desktop Data](#desktop-data) for locations and backup scope.

## Agent Profiles and Keys

Click **Settings** above the connection indicator in the sidebar, or press
**⌘ / Ctrl + ,**. Use **Models & credentials** for model and tool credentials, **Chat display**
for Normal/Quiet/Verbose tool activity and keyboard help, and **Runtime** for status,
logs, versions, and update controls. Connection details also has a **Runtime settings**
shortcut. Quiet hides tool activity but keeps approval requests visible; all three modes share
the saved preference with `/quiet`, `/normal`, `/verbose` and `/details`. Normal previews
six lines; Verbose expands all supplied output. Runtime-truncated content stays labeled. Display changes apply immediately.
Profile changes require **Save and apply**. Switching sections keeps unsaved
profile edits; closing Settings discards them.
When the default profile is missing a key required by its provider, Desktop also
opens Settings on startup so you can complete it before chatting.

Use **Add profile** to create another agent with the installed CLI’s provider
catalog, model and API-key fields. Creation makes it the default for new chats;
existing chats retain their agent. Choose a new agent ID; duplicates are rejected.
The new model key is scoped to the created agent and its model connection.
Shared search and web keys remain unchanged. Unsaved Settings edits require the
existing discard confirmation before creation.

1. Use **Import profiles…** to choose an existing Focus/CLI profile JSON file.
   Import adds agents and replaces matching agent IDs. It keeps Desktop's
   connection, storage, and other profiles in place.
2. Choose an agent to edit its model, provider URL, or model API
   key. The provider adapter comes from the imported profile; MiniMax uses the
   OpenAI-compatible adapter with the MiniMax endpoint.
3. Choose **Use this agent for new conversations** to change the default. Existing
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
adding multiple model connections, and editing prompts or policy are not yet in
this form; use the existing Focus/CLI configuration workflow for those fields.
The pinned PyPI runtime uses agent names as identities, so imported `name` values
must match their agent IDs. Settings preserves those names when editing a model
or key.

Settings are written to the private local OpenMinion config, with a private
`.backup` copy of the previous config. They are not a separate Desktop profile
format. Closing Settings discards unsaved edits. Changing the selected agent
asks for confirmation before discarding that agent’s unsaved fields. Your conversations remain saved when settings
are applied.

## Workspace Basics

If the daemon stops while the window stays open, click the connection indicator
at the bottom of the sidebar. Opening its details checks the current connection;
use **Reconnect** when offered. Your unsent message stays in the composer.

**Stop** requests cancellation. Desktop waits for and displays the outcome
reported by the daemon rather than treating the request itself as completion.

Text chat and completed conversation history work with the pinned runtime.
Request-bound allow-once or deny tool approvals work when Desktop is paired
with a compatible OpenMinion runtime. See the
[readiness matrix](certification-readiness-matrix.md) for managed-runtime evidence.
Attachment sending, artifact browsing, and
automatic watch remain preview-only; the connected app marks those integrations
unavailable.

You can write a local draft before the daemon connects. Creating a task draft and sending require the daemon connection. A new task is
explicitly local until its first message creates the canonical saved session. Draft text
is preserved when you connect and create the task.

Unsent text stays with its conversation across switching and app restarts. Desktop
saves text in its existing SQLite database; images and attachments are not restored.
A draft written before selecting a conversation remains separate at startup.
Creating another conversation starts with an empty composer. Storage failures
appear beside the composer so you can keep the window open and preserve the text.
A save is durable after the main process acknowledges it; text still in flight
at a sudden process failure is not guaranteed. Drafts are never sent automatically.

An accepted message clears only its saved draft revision, preserving text typed
while it was sending. Rejected submissions retain the draft. After sending,
your message remains visible while OpenMinion works, then the conversation
refreshes from canonical saved history. Closing a conversation clears its draft.
For a saved conversation, it also marks the session closed without erasing the
canonical transcript. Desktop does not provide a per-chat permanent-delete
control.

Write your first message and send it to create a task automatically. Use
**New conversation** in the sidebar to start another conversation. Use the send
button or **Enter** to send. **Shift+Enter** adds a new line.

Assistant replies show the reported profile beside **OpenMinion**. Desktop moves
a matching speaker prefix out of the displayed answer and copied reply; saved
transcripts remain unchanged. Completed replies show their saved duration and
usage below the answer, for example **22s · 18.4k tokens**. Token detail follows
the agent's CLI `turn_usage_display` setting when the runtime exports it:
total, input/output, or input/output plus model calls. These statistics survive
reopening a chat. Missing usage is not estimated, and
Desktop does not invent a cost when the runtime does not report one.

Progress uses a subtle working indicator, while
successful completion leaves the composer quiet. Stop requests and errors remain
visible; a stop request is not treated as confirmed cancellation.
While a reply is running, its status, details and elapsed time appear directly
beneath your request and scroll with the conversation. Stop replaces the send
arrow, and you can keep drafting. Stop stays pending until OpenMinion reports
the outcome. Successful completion hides the progress row; errors remain visible
with the request. The composer stays in place, and history refreshes without
clearing the conversation.

If a response disconnects, use **Reconnect response** to attach to the same
retained turn without sending your message again. If replay is unavailable,
**Check response status** checks whether the daemon still retains that turn.
When it no longer does, Desktop reloads saved history without claiming the turn
succeeded or failed. This recovery requires the current Desktop process to know
the trace; discovery after app or daemon restart is not supported.

Type `/` or press **Command/Ctrl+K** to open the command menu. Arrow keys select,
Tab completes, Shift+Tab leaves suggestions, and Enter runs a command. Start with `/help`, `/new`, `/sessions`,
or `/status`. Use the **Stop** button to stop a running turn.
Desktop is the GUI for Focus; command integration is currently incomplete.
See [Desktop Commands and Focus Parity](commands.md)
for the supported commands and remaining integration work.

The **+** button beside the composer opens image and file attachments.
**Screenshot** opens the screen or window chooser beside your message.
Choose **Entire screen** or **Window**, select a source, and **Start preview**.
The composer shows the selected source and its local preview. Pause, change,
or stop the preview from **Screenshot**. Preview pixels stay on this device in
the current app: screenshot attachment, guidance, and **Automatic watch** are
visible future-facing controls but are not connected to OpenMinion or a model.
Automatic watch, when implemented, will use repeated still frames rather than
continuous video and will remain separate from computer control.

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

## Name a chat

Click the conversation title, or choose **Rename** from the top-right conversation
menu. You can also right-click any conversation in the sidebar and choose
**Rename…** without opening it. With a sidebar conversation focused, press
**Shift+F10** to open the same menu. Enter a name and choose **Save**. **Cancel**
leaves it unchanged; **Reset name** restores the name reported by OpenMinion. The
dialog also shows the original session ID.

Names appear in the sidebar, chat heading, and Desktop session picker, and survive
restarting Desktop. They are saved only in this Desktop installation. Renaming
does not change the session ID, history, agent, or the CLI's saved session data;
continue using the original ID when resuming through the CLI. Names can also be
changed while a reply is running. Clearing Desktop's local application data removes
these local names.

## Export a conversation

Open a saved conversation, run `/export` from the composer or command menu,
then choose where to save the Markdown file. It contains messages already saved
by OpenMinion, not the unsent draft or an unfinished answer that has not been saved.
It is a separate readable copy, not a full installation backup. Review it before
sharing: it may include private prompts, responses, message metadata, and
session information.
Closing the chat or removing Desktop does not remove copies saved elsewhere.

## Daemon Status And Logs

Expand **Connected** (or **Not connected**) in the sidebar, then choose
**Daemon status** or **View logs**. A separate diagnostics dialog opens above
Desktop. **Refresh** reads a new snapshot; **Copy** copies the displayed output.
Logs show the latest 200 lines in a scrollable area, while the controls remain
visible. **Close** or Escape dismisses the dialog and returns focus to the sidebar. Your conversation, scroll position and draft stay in place. Logs do not
automatically follow new entries.

Desktop runs the installed CLI's `daemon status` and `daemon logs --lines 200`
with its recorded home, data, and profile paths. Inspection also works while
that daemon is stopped, once the runtime is installed. It does not reconnect,
restart, or replay a message. If no runtime or log exists yet, the view explains
that it is unavailable. These are daemon logs, separate from Electron's own
application logs.
