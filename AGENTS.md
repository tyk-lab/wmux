# Repository Guidelines

## Project Structure & Module Organization

`src/main/` contains Electron main-process services (PTYs, IPC, named pipe, hooks, persistence). `src/renderer/` is the Vite/React UI: components, Zustand slices, terminal hooks, styles, and the AI supervisor. `src/preload/` exposes the typed `window.wmux` bridge; `src/cli/` implements the `wmux` command. Shared IPC and branded IDs live in `src/shared/`. Unit tests belong in `tests/unit/`; runtime assets are in `resources/`, and the static site is in `site/`.

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

## Commit & Pull Request Guidelines

Follow the established Conventional Commit format: `feat(scope): summary`, `fix(scope): summary`, or `docs(readme): summary`. Keep scopes specific (for example, `supervisor`, `shell`, or `notify`) and summaries concise. Pull requests should explain the user-visible change, link relevant issues, list validation commands, and include screenshots or recordings for UI changes. Do not commit generated `dist/` output or local AI-tool configuration.

## Windows Integration Notes

Hooks and shell integrations are Windows-facing. Preserve named-pipe compatibility (`\\\\.\\pipe\\wmux`) and test hook changes with `npm run install:hooks`; never overwrite users' non-wmux hook entries.
