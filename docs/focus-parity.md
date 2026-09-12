# Focus Parity Contract

Status: active
Last updated: 2026-09-12

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
Desktop installs and runs ordinary OpenMinion and connects text turns and saved
history through its public CLI/API. The broader Focus command surface, approvals,
media, and artifacts still require Desktop integration.

| Surface | Current Desktop gap | Required outcome |
| --- | --- | --- |
| Catalog and help | A small static renderer list | Discover canonical names, aliases, usage, availability, and descriptions through fixed public OpenMinion operations |
| Arguments and busy state | `/tasks` supports inspection and pause/resume/cancel arguments; other commands mostly reject arguments and use local button rules | Use the same parser and command admission as Focus, including bare queries during a turn |
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

## Desktop Integration Handoff

The integration belongs in Desktop. Main receives a read-only command context
from the lifecycle owner and may invoke only fixed, validated ordinary CLI or
HTTP operations. Preload exposes narrow typed results, and the renderer presents
them. Executable paths, runtime roots, configuration, credentials, and generic
subprocess authority remain in main.

Do not restore Desktop-specific commands, routes, leases, or bootstrap code in
OpenMinion. Do not run arbitrary renderer-provided command strings, start a
second interactive terminal, or copy OpenMinion business logic into TypeScript.
Terminal-only actions such as clearing, copying, or exiting map to explicit GUI
actions with the same user intent. A catalog entry is never proof of execution
support.

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

## Connected Setup And Session Identity

First-launch onboarding reads the installed CLI's `setup --list-providers`
catalog and invokes fixed `setup --no-chat` arguments against a private candidate
config. Core owns provider defaults and profile construction. Desktop validates
and applies that config through its existing Settings lifecycle. Existing
configured agents use Settings or profile import; onboarding does not implement
the full CLI multi-model setup surface.

Saved-session sends read `sessions show --json` and retain its agent, channel,
and target. Desktop continues CLI-created conversations without rebinding them
to the identity used for new GUI sessions. Working-directory scope and the
broader `/resume` picker remain separate gaps.

## Connected Task Controls

On pinned PyPI 0.0.19, `/tasks` and `/task` use fixed `tasks list/show/pause/resume/cancel`
CLI calls. Main derives agent scope from the selected canonical session and passes
its session ID. Focus's task report and these CLI commands share OpenMinion's task
surface; Desktop does not copy lifecycle transitions, task ownership, or scheduler
logic. The CLI retains its default inventory limit of 50. GUI buttons come from
returned `valid_actions`; core validates them again on execution.

The renderer receives only task presentation fields and a pending-decision count.
Task changes are fenced against active Desktop turns and Settings updates. Reads
remain available during a turn. Pending decisions, task creation forms, and richer
run-history inspection still need integration. Tasks can already be created through
ordinary OpenMinion chat or CLI operations and then controlled here.

The current source tree includes `/close`, but the pinned PyPI Focus catalog does
not. Desktop retains its existing GUI Close operation without adding that slash
command prematurely. Broader catalog discovery remains a gap.

## Connected Reports And Export

On pinned PyPI 0.0.19, `/agents` (`/agent`) reads `GET /v1/agents`, backed by
Focus's agent-discovery owner. An exact ID or display name filters the returned
list; Desktop does not interpret it as agent selection. `/tools` (`/tool`)
reads `GET /v1/tools`, the daemon's live inventory. These narrow bridges return
only public IDs, labels, names, and enabled flags. Tool exposure arguments remain
unconnected. Filtering an agent waits for an active turn to finish; bare queries
remain available.

`/tokens` invokes `status tokens --session-id` and displays the canonical report
without recalculating usage. Live acceptance found that pinned PyPI returns
"Session was not found" for a daemon-created session which `sessions show` and
transcript export can read. Desktop reports token usage unavailable in this case;
resolving this runtime reporting failure remains a core limitation. `/export` turns Focus's export-command guidance into
a native save dialog backed by `export transcript --format md`. Both read saved
session state, including during a running turn. Export destinations stay in main.

Detailed status events now reach the renderer. The UI displays the runtime label,
detail, elapsed turn time, and time since the last event after a quiet interval.
It does not infer tool execution, model thinking, or progress percentages.

Focus model/effort selection, permissions, rooms, prompt queues, and live context
operate on interactive-runtime state. The pinned public CLI/daemon surface does
not provide a general Focus command dispatcher. Separate CLI reports or config
changes cannot stand in for those session operations.

The pinned 0.0.19 package already contains public session turn-input queue,
approval-resume, trace stream attachment, and runtime capability routes. Desktop
must qualify and consume their exact semantics before calling those workflows
connected or declaring a missing-core blocker. An approval grant alone does not
prove the original pending action resumed. Missing public semantics require an
explicit generic-owner dependency; Desktop must not import private Python runtime
code, start another interactive session, or duplicate those owners.

## Full GUI Workflow Scope

Parity includes the entire public CLI command tree and semantic arguments, not
only the slash menu. Guided and Advanced GUI workflows must cover configuration,
services, channels/pairings, schedules, projects/delegation, extensions, memory,
identity, graphs, diagnostics, data maintenance and operator utilities. Preserve
canonical effects while presenting friendly labels and controls; an instruction
to switch to CLI does not complete a GUI workflow.

As assessed on 2026-09-12, the pinned 0.0.19 parser registers 44 command families
and 243 leaf paths. Current source has 51 built-in Focus commands; the pin has
50. Desktop advertises 14 built-ins with partial semantics.
Bundled/user/project custom commands and shell intent add separate qualification
requirements. These counts are a dated source inventory, not execution proof.
Every static and dynamic GUI control needs an effective action, scope/error
behavior and actual Electron acceptance.

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
