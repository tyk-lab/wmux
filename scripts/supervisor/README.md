# Plan supervisor（按计划续任务）

> **UI 入口（推荐）**：侧栏底部「眼睛」按钮，或命令面板 `AI Supervisor…`。  
> 可多选监控终端、三档自由度（默认 Approve 人工闸门）、可选打开 AI 监督会话。  
> 本目录脚本仍可用于无 UI / CI / 远程调度。

用**你写好的计划**给多个 wmux agent 终端排队下发下一步。  
**默认不打开监督 AI 会话**——只是本地调度脚本；**不会自行发明任务**。

## 行为摘要

| 项 | 行为 |
|----|------|
| 决策 | 只发送 plan 里已写好的 `steps[].prompt` |
| 监督会话 | 默认关闭（无 AI pane） |
| 多终端 | `lanes[]` 每条绑定一个 `surfaceId` + `label` |
| 空闲条件 | `agent-state` 为 `idle` 才派发；`blocked` 只记日志、不续 |
| 记录 | 目标终端里可见注入文本；`logs/*.md` + `*.jsonl`；plan 内 step 状态回写 |

## 1. 写计划

复制 `plan.example.json`，改 `surfaceId` 与步骤：

```powershell
wmux list-surfaces
wmux agent-state
```

`lanes[].id` / `label` 用于区分终端；日志每一行都带 `laneId` + `surfaceId` + `stepId`。

步骤状态：`pending` → `in_progress` → `completed`（由脚本在观察到 idle 稳定后标记）。

## 2. 跑调度器（默认无监督 AI）

```powershell
# 先 dry-run 看会派什么
pwsh -File scripts/supervisor/Invoke-PlanSupervisor.ps1 -PlanPath scripts/supervisor/my-plan.json -DryRun -Once

# 实跑（后台轮询直到计划完成）
pwsh -File scripts/supervisor/Invoke-PlanSupervisor.ps1 -PlanPath scripts/supervisor/my-plan.json

# 可选：用 markdown 表面看日志（仍不是 AI）
pwsh -File scripts/supervisor/Invoke-PlanSupervisor.ps1 -PlanPath scripts/supervisor/my-plan.json -OpenLogSurface
```

## 3. 注入到终端的内容长什么样

每个 step 默认带前缀（可用 plan 里 `"promptPrefix": false` 关掉）：

```text
[wmux-supervisor | lane=lane-a | label=Auth 终端 | step=a1 | 1/2]
You MUST execute ONLY this planned step. ...
---
（你的 prompt）
---
```

因此**续任务记录直接出现在该 agent 的会话终端输入流**；同时写入：

- `scripts/supervisor/logs/<plan-name>.md`
- `scripts/supervisor/logs/<plan-name>.jsonl`

## 4. 防漂移约定（写进每一步 prompt）

- 写清**允许改的路径**与**禁止事项**
- 写清**完成条件**（编译过 / 测试过 / 仅创建某文件）
- 明确 **Stop when … Do not start the next task.**
- 需要换方向：停脚本 → 改 plan → 再启动（不要空闲 auto-continue 空话）

## 5. 参数

| 参数 | 含义 |
|------|------|
| `-PlanPath` | 计划 JSON（必填） |
| `-Once` | 只轮询一轮 |
| `-DryRun` | 不 send、不改 plan 状态 |
| `-OpenLogSurface` | `wmux markdown` 打开日志（非 AI） |
| `-AllowUnknown` | surface 状态 `unknown` 时也允许派发（较险） |
| `-WmuxCommand` | 自定义 wmux 可执行名/路径 |

Plan 字段：`pollSeconds`、`idleStableSeconds`、`submitEnter`、`promptPrefix`。

## 6. 前置条件

- wmux 已在跑，且目标 pane 内 agent 已装 hooks（或 `wmux wrap`），否则 `agent-state` 常为 `unknown`
- 本机 PATH 上有 `wmux`（或传 `-WmuxCommand`）
