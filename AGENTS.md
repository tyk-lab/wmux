# Repository Guidelines

## Project Structure & Module Organization

`src/main/` contains Electron main-process services (PTYs, IPC, named pipe, hooks, persistence). `src/renderer/` is the Vite/React UI: components, Zustand slices, terminal hooks, styles, and the AI supervisor. `src/renderer/supervisor/` implements the AI supervisor engine (decision bridge, delivery, protocol); `src/main/feishu-supervisor.ts` and `feishu-direct-task.ts` implement the Feishu remote-control gateway. `src/preload/` exposes the typed `window.wmux` bridge; `src/cli/` implements the `wmux` command. Shared IPC and branded IDs live in `src/shared/`. Unit tests belong in `tests/unit/`; runtime assets are in `resources/`, and the static site is in `site/`.

## Build, Test, and Development Commands

- `npm ci` installs the lockfile-pinned dependencies (requires Windows, Node 18+, and C++ build tools for `node-pty`).
- `npm run dev` starts Vite on port 5199 and opens Electron.
- `npm run build:main` recompiles main, preload, and CLI code; restart Electron after changing these areas.
- `npm run typecheck` checks both TypeScript configurations without emitting files.
- `npm test` runs the Vitest suite; use `npm run test:watch` while iterating.
- `npm run lint` lints `src/`; `npm run build` performs the production package build.

## Coding Style & Naming Conventions

Use TypeScript with the existing two-space indentation, semicolons, and single quotes. Prefer named React components and focused Zustand slice helpers. Name components in `PascalCase` (`WorkspaceRow.tsx`), hooks with `use` (`useTerminal.ts`), and implementation/test files in kebab-case (`agent-lifecycle-notify.ts`). Keep main/renderer boundaries explicit: add IPC channels and types in `src/shared/types.ts`, then expose them through preload deliberately. ESLint permits unused identifiers only when prefixed with `_`.

## Testing Guidelines

Add a focused `tests/unit/<feature>.test.ts` test for new state transitions, parsers, or notification behavior. Use descriptive Vitest cases such as `it('suppresses turn notifications while supervision is active', ...)`. Run the narrow test during development, then `npm test`, `npm run typecheck`, and `npm run lint` for changed TypeScript paths.

Keep project control-plane tests aligned with production ownership. Pure recovery, transition, admission, liveness, and other state predicates belong in focused policy modules under `src/renderer/project-manager/` and in matching policy tests; do not place their counterexample matrices in `engine`, store-slice, or decision-bridge tests merely because those layers call them. Store-slice tests cover reducer, persistence, and state-transition effects, while `supervisor-decision-bridge` tests cover only cross-layer routing and wiring; retain at most the smallest integration case there and test detailed policy branches at their owning module.

## Managed AI Control Plane

`src/renderer/project-manager/` owns persisted project and work-item state. `src/renderer/pipe-bridge.ts` owns manager delivery, supervisor-transition routing, execution-window replanning, and liveness recovery. Keep control-plane state changes covered by focused `tests/unit/project-manager-*.test.ts` and `tests/unit/supervisor-decision-bridge.test.ts` cases. Dynamic local handoff state belongs in `.project-plans/PROGRESS.md`, not in this file.

`resources/agents/project-ai/ROLE_AGENTS.md` and `resources/agents/supervisor-ai/ROLE_AGENTS.md` are application-owned stable role sources. `src/main/role-runtime-instructions.ts` deploys them as `AGENTS.md` into isolated managed-role runtimes; project IDs, work items, evidence, authorization, budgets, and current progress must remain in control-plane state rather than these files.

Project AI mode uses an intentionally asymmetric three-role chain:

- The project AI owns project-level intent: it turns the user goal into scope, stages, dependencies, priorities, and project-level acceptance. It does not implement the target project or prescribe concrete technical steps.
- The supervisor AI owns the current work item: it converts the approved contract into outcome-oriented batches, reviews returned evidence, and decides whether to continue, rework, complete, or escalate. It does not edit the target project or impose its internal protocol on the task AI.
- The task AI is the sole executor of the target project, the closest observer of the actual repository, and the final technical decision-maker. It owns implementation, debugging, testing, and necessary adjacent changes, and must correct higher-level assumptions when repository evidence contradicts them.
- The task AI must not know that the project AI or supervisor AI exists as an upstream internal role. It receives only a neutral outcome, scope and safety constraints, acceptance gaps, and relevant known facts—never role identities, project/lane IDs, routing state, budgets, or managed-role protocol text.
- During execution, the task AI follows the user goal and the target project's applicable `AGENTS.md`, skills, code conventions, interfaces, tests, and safety rules. Project-AI or supervisor-AI instructions cannot override those project rules or dictate a concrete implementation; conflicts must be reported through results and evidence.

Stable project-mode orchestration maxim: the project AI decides what the project must deliver and in what order; the supervisor AI decides how the current outcome is batched and verified; the task AI, grounded in the target project, decides how the work is technically done.

Ordinary AI supervision mode has no project AI layer. The ordinary supervisor AI orchestrates only the task supplied by the user, using the task goal, supplementary instructions, preconditions, stop conditions, scope, permissions, and other settings explicitly provided in the ordinary AI supervision configuration UI. It may split that task into outcome-oriented batches and review the returned evidence, but it must not invent a broader project plan or authority beyond the configured task.

In ordinary mode, the task AI is likewise the sole executor of the target project and must not know that an ordinary supervisor AI exists. The supervisor observes returned results and sends only neutral task outcomes and constraints; the task AI independently decides the technical implementation from repository evidence and follows the target project's applicable instructions, skills, interfaces, tests, conventions, and safety rules whenever they constrain the supervisor's plan.

Whenever either mode genuinely requires a user decision, present a complete decision package: the problem, current task and progress, the decision needed now, relevant evidence and impact, at least two mutually exclusive options, and one explicit recommended option. In project mode the project AI must first decide from the approved plan, current state, and existing authorization; only unresolved user-owned information, preference, risk authorization, or acceptance trade-offs reach the user. Ordinary supervision has no project-AI layer and presents the same decision package directly to the user.

Project and supervisor runtimes must call `wmux context` and then `wmux role-ready` before managed actions. Keep `role.ready` bound to a live per-surface capability in `src/main/pipe-server.ts`. When either role source changes, bump the corresponding revision in `src/shared/project-manager-terminal.ts` or `src/renderer/supervisor/protocol.ts`, and update packaging, runtime-deployment, isolation, and decision-bridge tests.

## Commit & Pull Request Guidelines

Follow the established Conventional Commit format: `feat(scope): summary`, `fix(scope): summary`, or `docs(readme): summary`. Keep scopes specific (for example, `supervisor`, `shell`, or `notify`) and summaries concise. Pull requests should explain the user-visible change, link relevant issues, list validation commands, and include screenshots or recordings for UI changes. Do not commit generated `dist/` output or local AI-tool configuration.

## Windows Integration Notes

Hooks and shell integrations are Windows-facing. Preserve named-pipe compatibility (`\\\\.\\pipe\\wmux`) and test hook changes with `npm run install:hooks`; never overwrite users' non-wmux hook entries.
