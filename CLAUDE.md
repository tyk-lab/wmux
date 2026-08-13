# wmux — Development Guide

Electron-based Windows terminal multiplexer for AI agents. TypeScript, React 19, Zustand, xterm.js, node-pty.

**Repo**: github.com/tyk-lab/wmux (fork of amirlehmam/wmux) | **Site**: wmux.org (Netlify, static from `site/`)
**Version**: 0.39.1

---

## Build & Dev

```bash
npm run dev            # Vite (port 5199) + Electron hot-reload
npm run build:main     # tsc main/preload/cli only (fast iteration)
npm run build:renderer # Vite production build (renderer only)
npm run build          # Full: clear locks → tsc + vite → electron-builder (NSIS)
npm run package:exe    # Package only (NSIS), reuses existing dist/
npm test               # Vitest unit tests
npm run test:watch     # Vitest watch mode
npm run lint           # ESLint src/
```

---

## Architecture

```
src/
  main/           Electron main process
  renderer/       React UI (Vite)
  preload/        contextBridge (window.wmux)
  cli/            CLI → named pipe (\\.\pipe\wmux)
  shared/         Shared types (IPC channels, branded IDs)
  shell-integration/  Shell hooks (bash/zsh/PowerShell/cmd)

resources/        Runtime assets (icons, themes, sounds, shell-integration, CLI)
  wmux-orchestrator/  Claude Code plugin (auto-installed on startup)
site/             Landing page (static HTML, Netlify)
tests/            Unit + e2e (Vitest)
docs/             Planning docs
```

### Main Process (`src/main/`)

| File | Role |
|------|------|
| `index.ts` | Entry point, AppUserModelId, auto-save (30s), pipe server startup, V2 pipe handlers (workspace/pane/surface/markdown/sidebar/notification) |
| `pty-manager.ts` | PTY lifecycle (create with surfaceId, write, resize, kill) |
| `pipe-server.ts` | Named pipe `\\.\pipe\wmux` — V1 text (shell hooks), V2 JSON-RPC (CLI/agents) |
| `cdp-bridge.ts` | Browser webview control via Chrome DevTools Protocol |
| `cdp-proxy.ts` | CDP WebSocket proxy |
| `agent-manager.ts` | Agent PTY spawning, round-robin distribution across panes |
| `window-manager.ts` | Electron BrowserWindow creation/management |
| `ipc-handlers.ts` | All IPC channel handlers |
| `claude-context.ts` | Configures Claude Code hooks and installs the wmux-orchestrator plugin |
| `kimi-context.ts` | Writes Kimi `[[hooks]]` into `~/.kimi-code/config.toml` (turn-level) |
| `codex-context.ts` | Merges wmux entries into `~/.codex/hooks.json` (turn-level) |
| `grok-context.ts` | Installs `~/.grok/hooks/wmux.json` (turn-level) |
| `opencode-context.ts` | OpenCode AGENTS.md inject + plugin install |
| `claude-style-hooks.ts` | Shared Claude/Codex/Grok hooks.json merge helpers |
| `wmux-hook-path.ts` | Absolute path to `resources/cli/wmux-hook.js` for outside-asar hook commands |
| `claude-observer.ts` | Monitors Claude Code activity for sidebar display |
| `agent-state.ts` | Declared agent run state — blocked/working/idle, run refcount, `seq` dedupe, metadata TTL (issue #128) |
| `agent-state-rpc.ts` | `pane.report_agent` & friends, routed off the main V2 switch |
| `agent-hook-bridge.ts` | Lifecycle hooks → declared state (Claude/Kimi/Codex/Grok shared event names) |
| `session-persistence.ts` | Auto-save/restore window state |
| `port-scanner.ts` | Active port detection for running dev servers |
| `shell-context-menu.ts` | "Open in wmux" Explorer verb — HKCU shell keys for Directory/Directory\Background/Drive, plus `directoryFromArgv` for the launch path. Win11 places it under "Show more options"; the modern menu needs a signed MSIX, which unsigned wmux cannot ship |
| `theme-loader.ts` | Theme loading |
| `config-loader.ts` | WT/Ghostty config import |
| `shell-detector.ts` | Available shells detection |
| `updater.ts` | Auto-update (electron-updater) |
| `feishu-supervisor.ts` / `feishu-direct-task.ts` | Feishu (Lark) remote control — control cards, human decisions, supervisor messaging, direct task creation |
| `supervisor-config-file.ts` / `supervisor-input-guard.ts` / `supervisor-records.ts` | AI supervisor main-process side: session config, input guard, audit records |
| `ssh-manager.ts` / `ssh-credential-store.ts` / `ssh-transfer-cache.ts` | SSH sessions, credentials, file transfers |
| `diff-provider.ts` | Diff surface content (`diff.refresh`) |
| `notification-manager.ts` | Main-process notification routing |
| `settings-store.ts` / `user-config.ts` | Persisted settings and user config files |
| `update-checker.ts` | Notify-only update checks (alongside `updater.ts`) |
| `v2-bridge.ts` / `v2-browser.ts` | V2 pipe bridging helpers |

### Renderer (`src/renderer/`)

**Components** (in `components/`):
- `SplitPane/` — PaneWrapper, SplitContainer, SplitDivider, SurfaceTabBar
- `Terminal/` — TerminalPane, FindBar, CopyMode, NotificationRing
- `Browser/` — BrowserPane, AddressBar
- `Sidebar/` — Sidebar, WorkspaceRow, SessionMenu, SidebarResizeHandle
- `Titlebar/` — Titlebar, NotificationBell, NotificationPanel
- `Settings/` — SettingsWindow + per-category panels
- `CommandPalette/` — CommandPalette
- `Markdown/` — MarkdownPane
- `Tutorial/` — Tutorial

**Hooks** (in `hooks/`):
- `useTerminal.ts` — xterm.js lifecycle, PTY connection, OSC notifications, WebGL renderer
- `useKeyboardShortcuts.ts` — 51+ shortcut actions, safe interception

**Pipe Bridge** (`pipe-bridge.ts`):
- Exposes Zustand store operations as `window.__wmux_*` globals
- Called by main process via `executeJavaScript` to bridge V2 pipe commands to renderer
- Covers: workspace CRUD, pane split/close/list, surface CRUD, markdown content, notifications

**Store** (Zustand, in `store/`):
- `workspace-slice.ts` — Workspace CRUD, split tree updates
- `surface-slice.ts` — Surface/tab add/close/move/navigate
- `settings-slice.ts` — Shortcuts, sidebar prefs, theme
- `notification-slice.ts` — Notification lifecycle (max 200)
- `agent-slice.ts` — Agent metadata tracking
- `split-utils.ts` — Immutable split tree helpers

**AI Supervisor** (in `supervisor/`):
- `supervisor-engine.ts` — Lane lifecycle and task delivery (`sendTaskToSurfaceReliably` uses the acknowledged `writeReliable` PTY queue)
- `protocol.ts` — Decision-boundary rules injected into supervisor terminals
- `delivery.ts`, `decision-options.ts`, `user-input-precedence.ts`, `generic-input-guard.ts`, `pending-input-guard.ts`, `session-restore.ts`, `recording.ts`, `launch-command.ts`

### Preload API (`window.wmux`)

```
pty:      create, write, writeChecked, writeReliable, resize, kill, has, onData, onExit
system:   platform, getShells, openExternal, toggleDevTools, pickFolder,
          getContextMenu, setContextMenu   # "Open in wmux" Explorer verb (HKCU)
config:   getTheme, getThemeList, importWindowsTerminal, importGhostty
metadata: onUpdate
notification: fire, onFocusSurface
browser:  navigate
agent:    list, status, onUpdate
clipboard: pasteImage
hook:     onEvent
claudeActivity: onUpdate
agentState: onUpdate   # declared blocked/working/idle (issue #128)
session:  save, load, list, delete
cdp:      attach, detach
window:   create, close, focus, list, minimize, maximize, isMaximized
```

---

## Key Design Decisions

### No MCP — CLI Only
Do NOT build MCP servers. Use the wmux CLI (`wmux <command>`) via Bash instead.
The CLI talks to the named pipe, which is simpler and more reliable.
For new Claude Code integrations, add CLI commands in `src/cli/wmux.ts`.

### Branded ID Types
`WorkspaceId`, `PaneId`, `SurfaceId`, `WindowId` — branded string types in `src/shared/types.ts`.
Pattern: `surf-{uuid}`, `pane-{uuid}`, `ws-{uuid}`, `win-{uuid}`.

### Keep-Alive Tabs
Terminal tabs in a pane are ALL rendered simultaneously (hidden with `visibility: hidden`).
When switching tabs, only CSS changes — the xterm instance stays alive, no PTY reconnection needed.
The `surfaceId` is passed to `pty.create()` so PTY ID = Surface ID (enables reliable re-attachment).

### Split Tree
Pane layouts use an immutable binary tree (`SplitNode`). Each leaf = one pane with N surfaces (tabs).
Mutations go through `splitNode()`, `removeLeaf()`, `findLeaf()`, `getAllPaneIds()` in `split-utils.ts`.

---

## Release Process

Packaging is driven by **electron-builder** — do NOT hand-roll zip releases.

```bash
npm run build          # Full pipeline: clear locks → tsc + vite → electron-builder (NSIS)
npm run package:exe    # Package only, reuses existing dist/ → release/wmux-<version>-setup.exe
```

- Pipeline: `scripts/build-package.mjs` wraps `electron-builder-safe.mjs` (clears stale win-unpacked locks before/after compile); config in `electron-builder.json` (`asarUnpack` covers node-pty prebuilds).
- Output lands in `release/` (setup.exe + blockmap + latest.yml); electron-updater clients consume `latest.yml`.
- winget manifests live in `winget/` — bump them when shipping a new setup.exe.
- The builder also persists allowlisted `WMUX_FEISHU_*` values from `.env` for the locally installed app (`syncLocalFeishuConfig()`).

---

## Named Pipe V2 Handlers

The pipe server in `index.ts` handles V2 JSON-RPC methods. Most delegate to the renderer via `executeJavaScript('window.__wmux_*(...)')`. The renderer's `pipe-bridge.ts` exposes Zustand store operations as these globals.

**Fully implemented V2 methods:**
- `system.identify`, `system.capabilities`, `system.tree`
- `workspace.create`, `workspace.close`, `workspace.select`, `workspace.rename`, `workspace.list`
- `pane.split`, `pane.close`, `pane.focus`, `pane.zoom`, `pane.list`
- `surface.create`, `surface.close`, `surface.focus`, `surface.rename`, `surface.list`
- `surface.send_text`, `surface.send_key`, `surface.read_text`, `surface.trigger_flash`
- `markdown.set_content`, `markdown.load_file`, `markdown.get_content`
- `notification.list`, `notification.clear`
- `sidebar.set_status`, `sidebar.set_progress`, `sidebar.log`, `sidebar.get_state`
- `browser.*` (via CDP bridge)
- `agent.spawn`, `agent.spawn_batch`, `agent.status`, `agent.list`, `agent.kill`
- `pane.report_agent`, `pane.report_agent_session`, `pane.report_metadata`, `pane.release_agent`, `pane.agent_state`
- `hook.event`, `diff.refresh`

---

## wmux-orchestrator Plugin

Claude Code plugin bundled in `resources/wmux-orchestrator/`. Auto-installed into `~/.claude/plugins/cache/` on startup by `ensureOrchestratorPlugin()` in `claude-context.ts`. Also published standalone: `github.com/amirlehmam/wmux-orchestrator`.

**What it does:** Decomposes complex dev tasks into parallel Claude Code agents coordinated through dependency-aware waves with automated review. With wmux: each agent in its own visible terminal pane. Without wmux: falls back to native subagents.

**Plugin structure:**
```
resources/wmux-orchestrator/
  .claude-plugin/plugin.json    Manifest (name, version, author)
  commands/orchestrate.md       /wmux:orchestrate slash command
  skills/orchestrate/SKILL.md   Core: codebase analysis, wave planning, agent spawning
  skills/reviewer/SKILL.md      Post-orchestration review and auto-fix
  skills/wmux-detect/SKILL.md   Detects wmux availability for degraded mode
  agents/wmux-worker.md         Worker template with file zone enforcement
  hooks/hooks.json              PostToolUse, SubagentStop, Stop, SessionStart
  scripts/json-tool.js          Node.js JSON helper (replaces jq)
  scripts/orchestration-state.sh  State file management library
  scripts/spawn-agents.sh       Creates panes + launches Claude Code agents
  scripts/on-agent-stop.sh      Wave transition driver (core orchestration)
  scripts/check-status.sh       Markdown dashboard generator
  scripts/*.sh                  Other utilities (cleanup, collect-results, etc.)
```

**Key design:** Skills handle intelligence (prompts), hooks handle reactivity (events), scripts handle wmux operations (CLI). State shared via JSON file in TMPDIR. No daemon.

---

## CLI Reference

```bash
# System
wmux ping | identify | capabilities
wmux new-window | list-windows | focus-window <id>

# Workspaces
wmux new-workspace [--title T] [--shell S] [--cwd D]   # --shell accepts args: --shell "ssh user@host"
wmux close-workspace | select-workspace | rename-workspace | list-workspaces
wmux ssh [ssh options] <user@host> [--title T]         # remote terminal in a new workspace (issue #78)

# Remote wmux management (issue #78): drive another machine's wmux over an SSH tunnel
wmux bridge [--port P] [--host H]     # on the remote: expose its pipe on TCP (default 127.0.0.1:9787)
wmux token                            # on the remote: print its auth token
wmux --remote host[:port] --token T <any command>   # on the client (through `ssh -L port:127.0.0.1:port`)
                                      # env equivalents: WMUX_REMOTE, WMUX_REMOTE_TOKEN

# Markdown surfaces
wmux markdown <file> | markdown set <id> --content <text> [--title T] | --file <path>
wmux markdown get <id>                                 # read a surface's buffer back out

# Surfaces (tabs within a pane)
wmux new-surface [--type terminal|browser|markdown]
wmux close-surface | focus-surface | rename-surface | list-surfaces

# Panes
wmux split [--down] [--type T] | close-pane | focus-pane | zoom-pane | list-panes | tree

# Terminal I/O
wmux send <text> | send-key <key> [--ctrl] [--shift] [--alt]
wmux read-screen [--lines N] [--surface <id>] | trigger-flash

# Browser (CDP)
wmux browser open <url> | snapshot | click eN | type eN <text>
wmux browser fill eN <value> | get-text | screenshot | eval <js>
wmux browser back | forward | reload

# Declared agent state (issue #128) — blocked / working / idle, no screen scraping.
# Surface defaults to $WMUX_SURFACE_ID, so an agent inside a pane needs no id.
wmux report-agent --blocked "permission: Bash"   # parked on a human
wmux report-agent --unblocked                    # the human answered
wmux report-agent --run-start | --run-end        # refcount, so nested subagents nest
wmux report-agent --run-depth N [--seq N]        # absolute depth; --seq drops replays
wmux report-metadata [--model M] [--tokens T] [--context-pct N] [--ttl ms]
wmux report-session <id> | release-agent
wmux agent-state [--surface <id>]                # no --surface → all panes + blocked list
# Process-level busy/idle for agents without native hooks:
wmux wrap [--label L] [--] some-agent

# Auto-installed turn hooks (on wmux startup OR `wmux install-hooks`) → report_agent:
#   Claude  → ~/.claude/settings.json
#   Kimi    → ~/.kimi-code/config.toml  (# wmux-hooks markers)
#   Codex   → ~/.codex/hooks.json       (may need /hooks trust once)
#   Grok    → ~/.grok/hooks/wmux.json
#   OpenCode→ ~/.config/opencode/plugin/wmux.js
# Scripts:  npm run install:hooks  |  scripts/install-agent-hooks.ps1|.mjs

# Agents
wmux agent spawn [--cmd C] [--label L] [--cwd D] [--pane P] [--replace-tab]
wmux agent spawn-batch --json '[...]' [--strategy distribute|stack|split]
wmux agent status <id> | list | kill <id>

# AI supervisor decision bridge (runs inside supervisor terminals)
wmux supervisor decide --surface <id> --outcome <continue|rework|complete|needs-human> \
    [--reason T] [--next T] [--proposal-kind route-adjustment|route-change|important] \
    [--impact T] [--alternatives T] [--permission-command C --permission-response y|yes|allow|approve] [--verbose]
# Success stays silent (keeps the transcript clean); delivery failures always print.
# With --next, pass --verbose to see the delivery confirmation.

# Notifications & Sidebar
wmux notify <text> | list-notifications | clear-notifications
wmux set-status <key> <value> | set-progress <val> [--label L]
wmux log <level> <message> | sidebar-state

# Hooks
wmux hook --event <type> --tool <name> [--agent <id>]
```

---

## IPC Channels

All defined in `src/shared/types.ts` → `IPC_CHANNELS`:

```
PTY:     pty:create, pty:write, pty:write-checked, pty:write-reliable, pty:resize, pty:kill, pty:has, pty:data, pty:exit
Window:  window:create/close/focus/list/minimize/maximize/isMaximized
Config:  config:getTheme/getThemeList/importWindowsTerminal/importGhostty
System:  system:getShells/openExternal
Notify:  notification:fire/list/clear/jump
Agent:   agent:spawn/spawn-batch/status/list/kill/update
CDP:     cdp:attach/detach
Session: session:save-named/load-named/list-named/delete-named
Meta:    metadata:update, hook:event, claude:activity, agent:state
```

---

## Shell Integration

Scripts in `src/shell-integration/` (deployed to `resources/shell-integration/`):

| Script | Reports |
|--------|---------|
| `wmux-powershell-integration.ps1` | cwd, git branch/dirty, shell state, PR polling (45s) |
| `wmux-bash-integration.sh` | cwd, git branch/dirty, shell state, ports |
| `wmux-cmd-integration.cmd` | Basic OSC 9 escape sequences |

Env vars set by wmux in spawned shells: `WMUX=1`, `WMUX_SURFACE_ID`, `WMUX_PIPE`, `WMUX_CLI`.

---

## Website (wmux.org)

Static site in `site/`. Deployed to Netlify (`netlify.toml` at repo root).

```bash
# Deploy
npx netlify deploy --prod --dir site
```

`site/index.html` — Landing page with i18n (English, French, Arabic, Japanese).
`site/i18n.js` — Language switching via URL hash (`#ar`, `#fr`, `#ja`).

---

## Testing

```bash
npm test                    # Run all unit tests
npm run test:watch          # Watch mode
npx vitest run tests/unit/pty-manager.test.ts  # Single file
```

70+ test files in `tests/unit/`, grouped by domain: `supervisor-*` (engine, decision bridge, delivery, guards, session restore), `feishu-*` (cards, routing, direct task), `terminal-*` (input delivery, keys, buffer cache), plus per-module tests mirroring `src/` (pty-manager, pipe-server, hooks, stores).

---

## Conventions

- **State**: Zustand slices in `src/renderer/store/`, composed in `index.ts`
- **IPC**: Channels defined in `src/shared/types.ts`, never use magic strings
- **CSS**: `src/renderer/styles/`, class prefix per component (`.pane-wrapper__*`, `.surface-tab__*`)
- **Immutable trees**: Split tree mutations always produce new objects via `patchLeaf()`
- **PTY IDs = Surface IDs**: Always pass `surfaceId` when creating PTYs for reliable re-attachment
- **No MCP**: All Claude Code integration via CLI commands
- **Chinese comms**: User communicates in Simplified Chinese, code/docs in English
