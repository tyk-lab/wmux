---
name: inspect-project-progress
description: Inspect a software project's current progress from repository evidence and report completed work, active work, blockers, risks, and next actions. Use when the user invokes /inspect-project-progress, asks for a project progress inspection, wants a project-management status summary, or needs current repository state checked without implementing changes.
---

# Inspect Project Progress

Inspect the project from current repository evidence. Do not implement changes unless the user separately requests implementation.

## Workflow

1. Resolve the project root from the current working directory.
2. Read the nearest project instruction files and durable status documents. Prefer `AGENTS.md`, `README.md`, `PROGRESS.md`, `PROJECT_UPDATES.md`, project plans, and task trackers when present.
3. Inspect the smallest useful set of current evidence:
   - Git branch, status, recent commits, and focused diff summary.
   - Relevant plans, issues, build metadata, and existing test or CI results.
   - Running task state or generated artifacts only when directly available.
4. Cross-check status claims against source files, commits, or verification output. Treat stale documentation as context, not proof.
5. Report the result in the user's language with the conclusion first.

## Reporting Format

- Overall status: one concise sentence.
- Completed: items supported by concrete evidence.
- In progress: unfinished changes and their current state.
- Blocked: blocking condition, impact, and required decision or dependency.
- Risks: only material risks supported by current evidence.
- Next actions: ordered, actionable steps with the highest-value step first.
- Verification: commands or artifacts used, including failures or unavailable evidence.

## Rules

- Remain read-only by default. Do not edit files, install dependencies, commit, push, publish, or send external messages.
- Do not claim completion from a plan, comment, or unverified working-tree change alone.
- Do not run full builds or broad test suites unless the user requests them or a cheap targeted check cannot answer the status question.
- Separate facts from inference. Mark uncertain conclusions clearly and state what evidence would resolve them.
- Preserve existing user work and ignore unrelated changes.
