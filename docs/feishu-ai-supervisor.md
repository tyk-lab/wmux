# 通过飞书管理 wmux AI 监督

本指南说明如何把飞书企业自建应用连接到 wmux：在指定群聊查看审计与人工决策，并由白名单用户在群聊或与机器人的单聊中，对已有终端开启、停止和管理 AI 监督。

wmux 使用飞书长连接，不需要给本机配置公网域名或回调地址；但运行 wmux 的电脑必须能访问飞书开放平台，且 wmux 必须保持运行。飞书侧的命令不会在 wmux 离线时排队执行。

## 你将获得的能力

- 白名单用户可在指定群或与机器人的单聊中列出已有终端、开启或停止 AI 监督，并向指定终端发送任务；命令回复返回命令所在对话。
- 当监督 AI 提交“需要人工决定”的建议时，收到带“批准 / 拒绝 / 停止监督”按钮的飞书卡片。
- 在飞书点击卡片或发送固定命令后，结果同步回 wmux；远程操作会写入项目的本地审计记录。
- 仅指定群和 Open ID 白名单内的成员能操作；任务只会发送到 `LIST` 返回的已有终端，不会创建新终端。

## 推荐使用方式

```text
白名单用户与机器人单聊  → LIST / START / SEND / STOP / DECIDE，结果回复到单聊
审计群（WMUX_FEISHU_CHAT_ID） → 启动、停止、裁决与人工审批卡片的审计记录
wmux 本地                 → 实际创建监督会话和监督终端
```

单聊适合日常控制，审计群适合留存过程记录和处理人工审批。单聊发送者必须在
`WMUX_FEISHU_ALLOWED_OPEN_IDS` 白名单中；审计群仅接受配置的群会话 ID。

## 1. 创建并配置飞书应用

1. 打开[飞书开放平台](https://open.feishu.cn/app)，创建**企业自建应用**。
2. 在“应用能力”中启用**机器人**。
3. 在“开发配置 → 权限管理 → API 权限”中，以**应用身份**开通：

   | 权限名称 | 权限标识 | 用途 |
   | --- | --- | --- |
   | 以应用的身份发消息 | `im:message:send_as_bot` | 发送通知、审计摘要和人工决策卡片 |
   | 获取群组中所有消息 | `im:message.group_msg` | 接收群内的 `WMUX SUPERVISOR` 命令 |

   当前实现支持不 @ 机器人的固定命令，因此需要“获取群组中所有消息”权限；它可能需要企业管理员审核。飞书对这两个权限的说明见[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create?lang=zh-CN)和[接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN)。

4. 在“开发配置 → 事件与回调 → 事件配置”中，选择**使用长连接接收事件**，并添加事件：**接收消息**（`im.message.receive_v1`）。
5. 在同一页面的“回调配置”中，选择**使用长连接接收回调**，并添加回调：**卡片回传交互**（`card.action.trigger`）。不要选择旧版带 `_v1` 后缀的卡片回调。
6. 在“应用发布 → 版本管理与发布”中创建并发布版本；如出现审核提示，请由企业管理员审核。
7. 将应用机器人加入准备管理 wmux 的目标群，并确认机器人在该群有发言权限。

飞书长连接与卡片回传的后台配置可参考[处理事件](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-events)和[处理卡片回调](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/handle-card-callbacks)。

## 2. 获取配置值

| 变量 | 从哪里获取 |
| --- | --- |
| `WMUX_FEISHU_APP_ID` | 应用详情页“凭证与基础信息”中的 App ID |
| `WMUX_FEISHU_APP_SECRET` | 同页的 App Secret；仅保存到本机环境变量 |
| `WMUX_FEISHU_CHAT_ID` | **审计目标群**的 `chat_id`，通常以 `oc_` 开头；可在开放平台 API 调试台的群信息返回值或事件日志中取得 |
| `WMUX_FEISHU_ALLOWED_OPEN_IDS` | 允许操作者的 `open_id`，多个 ID 用英文逗号分隔；可在开放平台“日志检索 → 事件日志检索”的消息事件中查看 `sender.sender_id.open_id` |

首次查 Open ID 时，可以先填一个占位 `ou_placeholder` 启动 wmux；飞书开发者后台仍会记录事件，只是该用户的命令会被 wmux 忽略。取得真实 Open ID 后再替换并重启 wmux。

`WMUX_FEISHU_CHAT_ID` 必须填写审计**群**的 ID，不能填写与机器人的单聊会话 ID。单聊控制不需要单独配置会话 ID，只需把操作者的 Open ID 放入白名单。

## 3. 设置 Windows 环境变量

### 自动读取项目 `.env`（推荐）

wmux 启动时会自动读取项目工作目录或 `wmux.exe` 同目录的 `.env`，且不会覆盖启动器已设置的同名环境变量。当前项目根目录已提供一个本机 `.env`，它指向你已填写的 `docs/env.txt`（`App ID`、`App Secret`、`群聊会话 ID`、`用户 ID`）。因此从该项目运行 `npm run dev` 时，无需再手动设置飞书变量。

两者都只应保存在本机，且已被 Git 忽略。若改为标准 `.env` 写法，可移除 `WMUX_FEISHU_ENV_FILE` 并填写：

```dotenv
WMUX_FEISHU_APP_ID=cli_xxx
WMUX_FEISHU_APP_SECRET=你的 App Secret
WMUX_FEISHU_CHAT_ID=oc_xxx
WMUX_FEISHU_ALLOWED_OPEN_IDS=ou_xxx,ou_yyy
```

修改 `.env` 或 `docs/env.txt` 后，必须完全退出并重新启动 wmux。

### 当前 PowerShell 会话（推荐用于首次测试）

```powershell
$env:WMUX_FEISHU_APP_ID = 'cli_xxx'
$env:WMUX_FEISHU_APP_SECRET = '你的 App Secret'
$env:WMUX_FEISHU_CHAT_ID = 'oc_xxx'
$env:WMUX_FEISHU_ALLOWED_OPEN_IDS = 'ou_xxx,ou_yyy'
npm run dev
```

### 持久保存给桌面版使用

在 PowerShell 中执行一次。设置后请**完全退出并重新启动 wmux**；已打开的 wmux 进程不会读取新变量。

```powershell
[Environment]::SetEnvironmentVariable('WMUX_FEISHU_APP_ID', 'cli_xxx', 'User')
[Environment]::SetEnvironmentVariable('WMUX_FEISHU_APP_SECRET', '你的 App Secret', 'User')
[Environment]::SetEnvironmentVariable('WMUX_FEISHU_CHAT_ID', 'oc_xxx', 'User')
[Environment]::SetEnvironmentVariable('WMUX_FEISHU_ALLOWED_OPEN_IDS', 'ou_xxx,ou_yyy', 'User')
```

不要把 App Secret 写入仓库、项目配置、计划文件或飞书消息。若从源码运行，安装依赖后执行 `npm run build`；若使用打包版，需使用包含该功能的新构建产物。

## 4. 启动 wmux、测试并操作

所有命令首行必须以 `WMUX SUPERVISOR` 开头。白名单用户可在审计群或与机器人单聊中发送；审计摘要与待决卡片仍发送到 `WMUX_FEISHU_CHAT_ID` 指定群。建议先按以下流程测试。

1. 按第 3 节设置环境变量后启动 wmux；从源码调试时运行 `npm run dev`。
2. 在与机器人的**单聊**中发送 `WMUX SUPERVISOR LIST`。
3. 从返回 JSON 的 `terminals` 中复制目标 `surfaceId`。
4. 发送下方的 `START`，为该已有终端开启 AI 监督。成功后应同时看到单聊成功回复、审计群的启动记录，以及 wmux 本地新开的监督终端。
5. 再发送一次 `LIST`，预期 `active` 为 `true`，目标终端的 `supervised` 为 `true`。测试结束后发送 `STOP`，审计群应出现停止记录。

查询终端：

```text
WMUX SUPERVISOR LIST
```

返回结果包含已有终端的 `surfaceId`。复制需要监督的 ID 后，发送启动监督命令：

```text
WMUX SUPERVISOR START
terminals: surf-xxx,surf-yyy
stop_when: npm test 通过且计划中的验收项完成
stop_when_kind: concrete
task_description: 可选；仅补充停止条件应如何理解
preconditions: 可选；已确认的环境或约束
plan_file: E:\work\project\PLAN.md
autonomous: off
supervisor_launch_cmd: codex
supervisor_model: gpt-5.6-sol
supervisor_reasoning: high
```

字段说明：

- `terminals` 和 `stop_when` 必填；`terminals` 必须来自 `LIST`。
- `stop_when_kind` 只能是 `concrete`（可验证条件）或 `direction`（目标方向）；默认 `concrete`。
- `task_description` 可选，仅用于补充说明停止条件，不会作为工作终端的新任务注入。
- `plan_file` 可选，必须是**运行 wmux 的 Windows 电脑上存在的绝对文件路径**；监督 AI 会在裁决时按文件更新时间决定是否重读。
- `autonomous` 只能是 `on` 或 `off`。即使为 `on`，删除或覆盖文件、Git 推送/重写、发布部署、云端或生产、凭据与权限变更仍必须人工处理。
- `supervisor_launch_cmd` 仅允许 `codex`、`claude`、`kimi`、`grok`、`opencode` 或留空，不能填任意 shell 命令。

`START` 只能引用同一台 wmux 的 `LIST` 返回的 `surfaceId`，不能自行编造。

### 向指定终端发送任务

先执行 `LIST` 取得目标终端 ID，再发送：

```text
WMUX SUPERVISOR SEND
terminal: surf-xxx
task: 运行相关测试并汇报结果
```

`SEND` 会把 `task` 作为终端输入并自动提交，因此只能由可信白名单用户使用。它只接受 `LIST` 中仍存在的已有工作终端，不能指向 AI 监督专用终端，也不能创建终端。文本命令中的 `task` 为单行；较长的说明请使用飞书审批卡片的输入框，或拆成多条任务发送。

停止当前监督：

```text
WMUX SUPERVISOR STOP
session: current
```

## 5. 处理人工决策

当监督 AI 使用 `needs-human` 提交重要建议时，wmux 会在飞书群发送决策卡片。卡片中可填写“后续任务”，再直接点击：

- **批准并发送任务**：后续任务必填；wmux 会将 AI 建议和填写的后续任务一起发送给相应工作终端。
- **拒绝**：不发送建议，通知监督 AI 继续基于当前路线监督。
- **停止监督**：停止当前监督会话。

也可以使用文本命令：

```text
WMUX SUPERVISOR DECIDE
approval_id: appr-xxx
action: approve
task: 按当前路线继续，完成测试后汇报结果
```

`action` 仅支持 `approve`、`reject`、`stop`。`approve` 必须带 `task`，作为后续任务发送到被监督终端；`reject` 和 `stop` 不需要 `task`。待决项超过 24 小时、已被处理，或监督会话已经停止时，wmux 会拒绝执行旧操作。

## 6. 端到端测试：任务发布与人工决策

此测试会向选定终端输入并提交内容。请使用专门的测试工作区和可安全中断的终端，勿选择生产、部署、含敏感凭据或有未保存工作的终端。

### 6.1 准备并开启测试监督

1. 在与机器人的单聊发送 `WMUX SUPERVISOR LIST`，记录一个测试终端的 `surfaceId`。
2. 发送下列命令开启监督。将 `surf-xxx` 替换为刚记录的 ID；不要使用 AI 监督专用终端。

```text
WMUX SUPERVISOR START
terminals: surf-xxx
stop_when: 已验证飞书任务发布、人工决策转发和停止审计后结束
stop_when_kind: concrete
task_description: 仅作飞书 AI 监督功能测试；不要执行删除、发布、部署或改动项目文件。
autonomous: off
supervisor_launch_cmd: codex
```

3. 在单聊确认收到启动回复；再发一次 `LIST`，应显示“监督会话：进行中”和该终端“状态：监督中”。审计群也应出现启动记录。

### 6.2 测试向终端发布任务

在单聊发送：

```text
WMUX SUPERVISOR SEND
terminal: surf-xxx
task: 这是飞书任务发布测试。不要改文件或执行命令；请仅回复“已收到飞书测试任务”，然后等待。
```

预期结果：飞书回复“已向 … 发送任务”，目标终端显示该任务并自动提交，AI 回复确认信息。再次执行 `LIST`，终端仍为“监督中”。

### 6.3 触发并处理用户决策

继续向同一工作终端发送一个需要明确人类选择的安全测试任务：

```text
WMUX SUPERVISOR SEND
terminal: surf-xxx
task: 这是人工决策测试。不要改文件或执行命令；请提出“方案 A 或方案 B 需要用户选择”，不要自行选择，并等待。
```

监督 AI 会把工作终端明确提出的“方案 A / 方案 B 需要用户选择”视为必须人工决策，提交 `needs-human`，而不能用 `continue` 或 `rework` 替代；这一步可能需要等待一个监督裁决周期。出现审批卡片后：

1. 在审计群卡片的“后续任务”中填写：`选择方案 A；不要改文件，只确认已收到。`
2. 点击**批准并发送任务**。
3. 确认卡片更新为“人工决策已处理”，工作终端收到 AI 建议和刚填写的后续任务，审计群出现决策记录。

如需测试文本决策而不是卡片，从 `LIST` 的 `pendingApprovals` 中取得 `approval_id` 后发送：

```text
WMUX SUPERVISOR DECIDE
approval_id: appr-xxx
action: approve
task: 选择方案 A；不要改文件，只确认已收到。
```

也可分别点击**拒绝**（不转发任务、监督继续）和**停止监督**（结束会话）来测试对应分支；每个待决项只能处理一次。

### 6.4 收尾与验收清单

测试完成后发送：

```text
WMUX SUPERVISOR STOP
session: current
```

| 检查项 | 预期结果 |
| --- | --- |
| `LIST` | 能看到友好的终端状态、监督状态和终端 ID。 |
| `START` | 本地创建监督终端，审计群收到启动记录。 |
| `SEND` | 指定工作终端收到并提交测试任务。 |
| 人工决策 | 审批卡片可填写后续任务；批准后内容被转发到被监督终端。 |
| `STOP` | 飞书回复停止成功，审计群出现停止记录，`LIST` 显示未启动。 |

若审批卡片始终没有出现，但 `SEND` 已成功，请先确认工作终端是否真的提出了必须由用户决定的问题；这不一定表示飞书连接故障。可用第 6.3 节的安全测试任务重新触发，或改用已有待决项测试文本 `DECIDE`。

## 7. 审计、安全与故障排查

本地完整审计仍保存在各项目的 `.wmux/supervisor/<sessionId>/events.ndjson`；飞书只收到脱敏摘要，不发送终端全文、密钥、令牌、密码、绝对路径或计划文件正文。

| 现象 | 检查项 |
| --- | --- |
| 群里没有收到命令回复 | wmux 是否运行；四个环境变量是否都在启动 wmux 的进程环境中；App 是否已发布；机器人是否已加入目标群 |
| 机器人只发通知、不执行命令 | 群聊：`WMUX_FEISHU_CHAT_ID` 是否为该群的 `chat_id`；单聊：发送者的 Open ID 是否在 `WMUX_FEISHU_ALLOWED_OPEN_IDS`；群聊还需已开通 `im:message.group_msg` |
| 能收到命令但卡片按钮报错 | 回调配置中是否添加的是 `card.action.trigger`，且使用“长连接接收回调” |
| 飞书显示已发送但 wmux 没有动作 | wmux 界面可能尚未初始化，或会话已停止；先在 wmux 中打开窗口并重新执行 `LIST` |
| 不希望机器人读取群内所有消息 | 当前命令可不 @ 机器人，因此必须申请群消息权限。若企业安全策略不允许，应将实现改为“仅 @机器人触发”，再使用更小的 @消息权限 |

请将此群限定为管理群，并只把可信操作者的 Open ID 加入白名单。

### 本次接入中遇到的问题

| 现象 | 原因 | 处理方式 |
| --- | --- | --- |
| 单聊发送 `WMUX SUPERVISOR LIST` 没有回复，日志出现 `dm_disabled` | 旧进程只允许群聊，或仍在使用旧版本 | 使用支持单聊白名单的版本，确认发送者 Open ID 已加入 `WMUX_FEISHU_ALLOWED_OPEN_IDS`，然后重启 wmux。 |
| 单聊能收到回复，但审计消息没有到预期位置 | `WMUX_FEISHU_CHAT_ID` 填成了单聊 ID，或修改环境变量后没有重启 | 将它设置为实际审计群的 `oc_...` ID；单聊不配置 chat ID；完整重启 wmux 后重测。 |
| 日志有 `[ws] ws client ready`，但命令仍无结果 | 这只表示长连接已建立，不代表事件、权限和访问策略均正确 | 检查 `im.message.receive_v1` 已发布、消息权限已开通，并检查单聊白名单或审计群 ID。 |
| 本地监督终端提示 `TERM is set to "dumb"`，Codex 拒绝启动交互界面 | 旧 Electron/终端进程继承了 `TERM=dumb` | 使用包含 TERM 修复的 wmux 并重启；停止旧监督会话后新建会话。不要在旧提示中输入 `y`，该会话无法靠确认恢复。 |

## 8. 人工审批如何流转

正常的 `continue`、`rework`、`complete` 裁决只会写入审计记录。只有监督 AI 提交 `needs-human` 时，wmux 才会在审计群发送审批卡片；卡片可选择批准、拒绝或停止，处理结果会同步回 wmux 的当前监督会话。

飞书任务输入受 Open ID 白名单、审计群和当前终端 ID 校验保护；由于 `SEND` 与“批准并发送任务”会实际向终端输入并提交内容，请仅向可信用户授予白名单权限。AI 自主监督仍不会绕过关键风险限制。
