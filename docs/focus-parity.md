# Focus Parity Contract

Status: active
Last updated: 2026-09-08

Purpose: define Desktop as the GUI representation of OpenMinion Focus/CLI and
record the integration required to make their behavior match.

## Product Contract

Focus/CLI is authoritative. Desktop must expose the same supported operations,
command names, aliases, argument parsing, defaults, session scope, busy-turn
rules, permissions, and durable effects. Buttons, pickers, and panels present
these operations graphically. Missing functionality is unfinished integration,
not an intentional Desktop variant.

The canonical OpenMinion owners are:

- `src/openminion/cli/presentation/slash_commands.py`: catalog, aliases, help,
  and busy-turn classification.
- `src/openminion/cli/interactive/terminal/shell/actions.py`: Focus dispatch.
- `src/openminion/cli/interactive/terminal/shell/sessions.py`: new sessions,
  resume filtering, and room operations.
- `src/openminion/cli/interactive/terminal/shell/slash_output.py` and
  `src/openminion/cli/interactive/terminal/transcript.py`: transcript operations.

Inspect the actual handlers as well as the catalog: a help entry alone does not
prove an operation works in Focus. For example, Focus's `/editor` currently
returns composition guidance. Match that supported behavior without inventing
external-editor execution. Preserve explicit renderer availability where Focus
and the rich CLI renderer differ.

## Current Differences

This is a source assessment, not end-to-end parity certification. The current
daemon capabilities cover sessions, turns, approvals, media, and artifacts;
there is no shared Focus command discovery or execution contract.

| Surface | Current Desktop gap | Required outcome |
| --- | --- | --- |
| Catalog and help | A small static renderer list | Discover canonical names, aliases, usage, availability, and descriptions from the matched daemon |
| Arguments and busy state | Desktop rejects arguments and applies local button rules | Use the same parser and command admission as Focus, including bare queries during a turn |
| `/new`, `/sessions` | Saved-task creation and selection exist; Focus directory scope is not established | Preserve working directory, selected agent, session scope, and canonical creation/binding defaults |
| `/resume` | Not connected; the incorrect `/sessions` alias was removed | Present prior sessions with messages in the current directory, then bind and load history |
| `/model` | Reports session metadata only | Present configured choices and perform canonical model selection; return effective settings |
| `/status` | Reports connection and partial session metadata | Include canonical agent, model, session, and working-directory facts |
| `/clear`, `/copy` | Visible chat clearing and assistant copying exist; canonical tool-output ordering is missing | Match Focus transcript clearing and latest copyable agent/tool output; never copy user input as a fallback |
| Tool presentation | `/quiet` and `/normal` toggle summary cards | Match quiet, normal truncation, verbose, details, and expansion using canonical tool content |
| Type-ahead | Drafts remain unsent during a turn | Match Focus queue admission, inspection, and control through the runtime owner |
| Recovery | Running turns survive task switches in one app | Reattach to the same running turn and pending approvals after restart |

The GUI's Context/files panel is not Focus's context-budget report. Screen
capture remains a GUI input method. Files, screenshots, cancellation, task
closing, and reconnection keep their existing buttons; they do not introduce
additional slash names.

## Daemon Integration Handoff

The following is a proposed contract for the OpenMinion integration owner,
not an implemented API. Do not add callable preload methods before the daemon
implements and versions this contract. Reuse existing runtime owners and
extract shared behavior from terminal handlers where necessary; do not invoke
a second interactive CLI process or copy its business logic into TypeScript.

Two authenticated daemon operations are needed:

1. `focus.commands.list({ sessionId })` returns the canonical catalog for the
   admitted session: `name`, `aliases`, `description`, `usage`, `available`, and
   `unavailableReason` for each command. Availability includes current runtime
   capabilities. The daemon remains authoritative when a command is executed.
2. `focus.commands.execute({ requestId, sessionId, command, argumentText })`
   resolves a registered command through the shared Focus parser and handler.
   `argumentText` preserves the user's arguments for canonical parsing; it is
   never evaluated as a shell command or submitted as an assistant prompt.
   Return the canonical result and any changed selected-session identity.

The daemon owner must version the result schema for text, structured reports,
choices, and transcript presentation actions. Choice selection must return to
the same command operation with a daemon-issued interaction ID and choice ID;
Desktop must not construct a new command from a display label. Commands that
need confirmation use existing approval ownership and decision flow. Errors
use the current error envelope, and effects use existing session/turn events.
Requests must retain the current client lease, admitted-session, cancellation,
and duplicate-request protections. Credentials remain daemon-owned.

Desktop main then calls these fixed authenticated operations, preload exposes
their typed application methods, and the renderer presents results. Terminal
actions such as clearing, copying, or exiting map to explicit GUI actions with
the same user intent. A catalog entry is never proof of execution support.

All canonical command families need coverage:

| Commands and aliases | Existing behavior to expose or present |
| --- | --- |
| `/help`, `/` | Canonical catalog and help |
| `/new`, `/new session`, `/sessions`, `/session`, `/resume` | Directory-scoped session creation, inventory, binding, and history |
| `/participants`, `/invite`, `/kick`, `/activate`, `/routing` | Room membership and routing |
| `/agents`, `/agent`, `/model`, `/effort` | Agent inspection/selection, configured model choices, effective effort |
| `/delegate`, `/goal`, `/project`, `/tasks`, `/task`, `/queue` | Existing delegation, goal, project, durable task, and prompt-queue owners |
| `/tools`, `/tool`, `/mcp`, `/skills` | Configured tool, server, and skill inventory and supported changes |
| `/permissions`, `/readonly` | Canonical policy queries, updates, and effective mode |
| `/context`, `/context-review`, `/compact`, `/cost`, `/tokens` | Context evidence, supported compaction, live/durable usage, available cost |
| `/memory`, `/graph`, `/telemetry`, `/trace`, `/overview` | Owner reports and supported operations, with renderer availability preserved |
| `/init`, `/browser`, `/undo`, `/diff`, `/review` | Existing workspace/browser operations with policy and audit boundaries |
| `/clear`, `/cls`, `/copy`, `/quiet`, `/normal`, `/verbose`, `/details`, `/expand` | Canonical transcript content and presentation semantics |
| `/status`, `/theme`, `/statusline`, `/export`, `/editor`, `/exit`, `/quit` | Status, presentation preferences, supported guidance, and exit intent |

## Acceptance

Compare Focus and Desktop against the same daemon revision, configuration,
working directory, provider fixture, and equivalent isolated session state.
Do not use the locally installed CLI version as a substitute for the matched
daemon revision.

For every canonical command and alias, cover its supported arguments, invalid
arguments, disconnected state, busy-turn behavior, permission decisions, and
effective state changes. Exercise pickers and other interactive continuations,
not only bare read-only forms. Assert catalog agreement so additions cannot
silently drift. Compare semantic results and durable effects rather than
terminal formatting.

Use actual Electron plus the daemon for GUI acceptance, including keyboard
entry, narrow-window controls, cancellation, task switching, and restart
recovery. Keep provider-free, live-provider, native-permission, and release
proof separate as defined in [Testing and Validation](testing-and-validation.md).

Full parity remains open until these checks pass. The current command subset
is documented in [Desktop Commands and Focus Parity](commands.md).
