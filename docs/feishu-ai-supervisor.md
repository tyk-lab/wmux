# 通过飞书管理 wmux AI 监督

本指南说明如何把飞书企业自建应用连接到 wmux：在指定审计群查看脱敏监督过程，并由白名单用户在与机器人的单聊中，对已有终端开启、停止和管理 AI 监督及处理人工决策。

wmux 使用飞书长连接，不需要给本机配置公网域名或回调地址；但运行 wmux 的电脑必须能访问飞书开放平台，且 wmux 必须保持运行。飞书侧的命令不会在 wmux 离线时排队执行。

## 你将获得的能力

- 白名单用户可在与机器人的单聊中列出已有终端、开启或停止 AI 监督，并向指定终端发送任务；命令回复返回该单聊。
- 日常控制无需记忆命令：发送“wmux帮助”即可打开菜单，按卡片选择终端并填写任务或停止条件。
- 审计群实时接收任务、生命周期、监督投递、裁决、授权和会话结束等脱敏审计事件；终端屏幕全文不会外发。
- 当监督 AI 提交“需要人工决定”的建议时，配置的决策单聊（未配置时为最近联系机器人的白名单用户单聊）会收到带“批准并发送任务 / 暂停监督 / 停止监督”按钮的飞书卡片。
- 在飞书点击卡片或发送固定命令后，结果同步回 wmux；远程操作会写入项目的本地审计记录。
- 仅指定群和 Open ID 白名单内的成员能操作；任务只会发送到 `LIST` 返回的已有终端，不会创建新终端。

## 推荐使用方式

```text
白名单用户与机器人单聊  → LIST / START / SEND / STOP / DECIDE、审批卡片与决策结果
审计群（WMUX_FEISHU_CHAT_ID） → 非决策类脱敏监督过程，不接收控制命令
wmux 本地                 → 实际创建监督会话和监督终端
```

单聊用于日常控制和人工审批，审计群用于留存非决策类监督过程。单聊发送者必须在
`WMUX_FEISHU_ALLOWED_OPEN_IDS` 白名单中。默认不允许在审计群发控制命令，避免命令、回复和审计混在同一会话。

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
| `WMUX_FEISHU_CONTROL_CHAT_ID` | 可选的**独立控制群** `chat_id`；未设置时只允许单聊控制，推荐保持为空 |
| `WMUX_FEISHU_DECISION_CHAT_ID` | 推荐填写的**人工决策单聊** `chat_id`；设置后待决卡片可在 wmux 启动后直接推送，无需先发送“wmux帮助”激活单聊 |
| `WMUX_FEISHU_ALLOWED_OPEN_IDS` | 允许操作者的 `open_id`，多个 ID 用英文逗号分隔；可在开放平台“日志检索 → 事件日志检索”的消息事件中查看 `sender.sender_id.open_id` |

首次查 Open ID 时，可以先填一个占位 `ou_placeholder` 启动 wmux；飞书开发者后台仍会记录事件，只是该用户的命令会被 wmux 忽略。取得真实 Open ID 后再替换并重启 wmux。

`WMUX_FEISHU_CHAT_ID` 必须填写审计**群**的 ID，不能填写与机器人的单聊会话 ID。人工决策单聊可通过 `WMUX_FEISHU_DECISION_CHAT_ID` 单独配置；单聊控制权限仍由操作者 Open ID 白名单决定。

## 3. 设置 Windows 环境变量

### 自动读取项目 `.env`（推荐）

wmux 启动时会自动读取项目工作目录或 `wmux.exe` 同目录的 `.env`，且不会覆盖启动器已设置的同名环境变量。当前项目根目录已提供一个本机 `.env`，它指向你已填写的 `docs/env.txt`（`App ID`、`App Secret`、`群聊会话 ID`、`用户 ID`）。因此从该项目运行 `npm run dev` 时，无需再手动设置飞书变量。

两者都只应保存在本机，且已被 Git 忽略。若改为标准 `.env` 写法，可移除 `WMUX_FEISHU_ENV_FILE` 并填写：

```dotenv
WMUX_FEISHU_APP_ID=cli_xxx
WMUX_FEISHU_APP_SECRET=你的 App Secret
WMUX_FEISHU_CHAT_ID=oc_xxx
WMUX_FEISHU_DECISION_CHAT_ID=oc_xxx
# 仅需要独立控制群时才填写；默认留空，只用单聊控制
# WMUX_FEISHU_CONTROL_CHAT_ID=oc_xxx
WMUX_FEISHU_ALLOWED_OPEN_IDS=ou_xxx,ou_yyy
```

修改 `.env` 或 `docs/env.txt` 后，必须完全退出并重新启动 wmux。

### 当前 PowerShell 会话（推荐用于首次测试）

```powershell
$env:WMUX_FEISHU_APP_ID = 'cli_xxx'
$env:WMUX_FEISHU_APP_SECRET = '你的 App Secret'
$env:WMUX_FEISHU_CHAT_ID = 'oc_xxx'
$env:WMUX_FEISHU_DECISION_CHAT_ID = 'oc_xxx'
$env:WMUX_FEISHU_ALLOWED_OPEN_IDS = 'ou_xxx,ou_yyy'
npm run dev
```

### 持久保存给桌面版使用

在 PowerShell 中执行一次。设置后请**完全退出并重新启动 wmux**；已打开的 wmux 进程不会读取新变量。

```powershell
[Environment]::SetEnvironmentVariable('WMUX_FEISHU_APP_ID', 'cli_xxx', 'User')
[Environment]::SetEnvironmentVariable('WMUX_FEISHU_APP_SECRET', '你的 App Secret', 'User')
[Environment]::SetEnvironmentVariable('WMUX_FEISHU_CHAT_ID', 'oc_xxx', 'User')
[Environment]::SetEnvironmentVariable('WMUX_FEISHU_DECISION_CHAT_ID', 'oc_xxx', 'User')
# 仅需要独立控制群时才执行：
# [Environment]::SetEnvironmentVariable('WMUX_FEISHU_CONTROL_CHAT_ID', 'oc_xxx', 'User')
[Environment]::SetEnvironmentVariable('WMUX_FEISHU_ALLOWED_OPEN_IDS', 'ou_xxx,ou_yyy', 'User')
```

不要把 App Secret 写入仓库、项目配置、计划文件或飞书消息。若从源码运行，安装依赖后执行 `npm run build`；若使用打包版，需使用包含该功能的新构建产物。

## 4. 启动 wmux、测试并操作

默认请在与机器人的单聊中发送“**wmux帮助**”（也支持 `WMUX HELP` 或“帮助”）。机器人会显示**查看状态、启动监督、发送任务、停止监督**菜单；点击后选择终端、填写表单即可操作，无需复制 `surfaceId` 或输入长命令。普通监督审计摘要发送到 `WMUX_FEISHU_CHAT_ID` 指定群，待决卡片和决策结果只发送到白名单用户单聊。推荐设置 `WMUX_FEISHU_DECISION_CHAT_ID`，使 wmux 每次启动后都能直接推送人工决策；未设置时使用最近联系机器人的白名单单聊，并在首次有效单聊前暂存待决消息。仅在设置了 `WMUX_FEISHU_CONTROL_CHAT_ID` 后，才可在该独立控制群发送高级非决策文本命令。

人工决策卡提供“批准并发送任务 / 暂停监督 / 停止监督”。暂停只保留当前会话和待决项，不会把它记为拒绝；继续监督后原卡仍可处理。若用户改为直接向对应任务终端发送信息，该信息本身会记为已完成的人工裁决，待决卡同步更新，监督保持运行。

### 日常卡片操作（推荐）

1. 在与机器人的单聊发送：`wmux帮助`。
2. 点击**查看状态**：返回当前监督状态与可用终端，再显示菜单。
3. 点击**启动监督**：选择未监督终端，或标有“已停止，可重新监督”的终端，填写停止条件；后者会关闭旧专属监督 AI、清除旧会话裁决上下文，并按当前填写的条件创建新会话，不会向工作终端发送新任务。补充说明、前置条件、计划文件和全自动开关均可选填。
4. 点击**发送任务**：选择目标终端，填写任务后提交。该操作会直接向终端输入并执行文本。
5. 点击**停止监督**：结束当前监督会话，随后仍可从菜单重新启动。

“全自动”关闭时也不是纯人工模式：普通监督仍按会话中已勾选的自主权限行动。飞书远程启动使用推荐默认值：允许四类低风险自主能力，范围限定为当前工程文件夹，并禁止新增依赖、改变公共 API、大范围重构和削弱测试。重大改向、业务取舍、高影响操作和用户专属授权仍进入人工决策。

人工决策通过机器人单聊中的审批卡处理；选择方案、填写后续任务后点击批准即可转发给被监督终端。

### 高级文本命令（可选）

下方固定文本命令仍可用于排障或自动化；日常使用优先卡片菜单。

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
- `supervisor_launch_cmd` 仅允许 `codex`、`claude`、`kimi`、`grok`、`pi`、`opencode` 或留空，不能填任意 shell 命令。

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

当监督 AI 使用 `needs-human` 提交重要建议时，wmux 会向 `WMUX_FEISHU_DECISION_CHAT_ID` 配置的单聊发送决策卡片；未配置时使用最近联系机器人的白名单用户单聊，且在首次有效单聊前暂存卡片。决策卡不会回退发送到审计群。若 AI 提供的备选中包含“方案 A / 方案 B”等明确选项，卡片会提供下拉选择；再填写“后续任务”并点击：

- **批准并发送任务**：后续任务必填；wmux 会将 AI 建议和填写的后续任务一起发送给相应工作终端。
- **暂停监督**：保留当前会话、监督终端和待决项；继续监督后仍可使用原决策卡。
- **停止监督**：停止当前监督会话。

也可以使用文本命令：

```text
WMUX SUPERVISOR DECIDE
approval_id: appr-xxx
action: approve
task: 按当前路线继续，完成测试后汇报结果
```

`action` 支持 `approve`、`pause`、`stop`，并为兼容旧文本命令保留 `reject`。`approve` 必须带 `task`，作为后续任务发送到被监督终端；其他动作不需要 `task`。待决项超过 24 小时、已被处理，或监督会话已经停止时，wmux 会拒绝执行旧操作。

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
task: 这是人工决策测试。不要改文件或执行命令；请提出“对外产品文案采用方案 A 或方案 B，需要产品所有者选择”，不要自行选择，并等待。
```

单纯的低风险技术方案 A/B 现在由监督 AI 自主选择；涉及产品偏好、外部承诺或用户独有授权时才提交 `needs-human`。这一步可能需要等待一个监督裁决周期。出现审批卡片后：

1. 在机器人单聊卡片中选择“方案 A”（若出现下拉选项），并在“后续任务”中填写：`不要改文件，只确认已收到。`
2. 点击**批准并发送任务**。
3. 确认单聊卡片更新为“人工决策已处理”，工作终端收到 AI 建议和刚填写的后续任务；决策内容不会发送到审计群。

如需测试文本决策而不是卡片，从 `LIST` 的 `pendingApprovals` 中取得 `approval_id` 后发送：

```text
WMUX SUPERVISOR DECIDE
approval_id: appr-xxx
action: approve
task: 选择方案 A；不要改文件，只确认已收到。
```

也可分别点击**暂停监督**（保留待决项和监督上下文）和**停止监督**（结束会话）来测试对应分支。暂停后原待决项仍可继续处理；批准、直接向任务终端发送信息或停止后，该待决项才会结束。

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

若审批卡片始终没有出现，但 `SEND` 已成功，请先在机器人单聊发送一次“wmux帮助”，再确认工作终端是否真的提出了必须由用户决定的问题；这不一定表示飞书连接故障。可用第 6.3 节的安全测试任务重新触发，或改用已有待决项测试文本 `DECIDE`。

## 7. 审计、安全与故障排查

本地完整审计仍保存在各项目的 `.wmux/supervisor/<sessionId>/events.ndjson`；飞书只收到脱敏摘要，不发送终端全文、密钥、令牌、密码、绝对路径或计划文件正文。

| 现象 | 检查项 |
| --- | --- |
| 单聊没有收到命令回复 | wmux 是否运行；必需的四个环境变量是否都在启动 wmux 的进程环境中；App 是否已发布；发送者 Open ID 是否在白名单 |
| 审计群不执行命令 | 这是默认设计；请改在单聊控制。只有配置了 `WMUX_FEISHU_CONTROL_CHAT_ID` 的独立控制群才接受群聊命令。 |
| 能收到命令但卡片按钮报错 | 回调配置中是否添加的是 `card.action.trigger`，且使用“长连接接收回调” |
| 飞书显示已发送但 wmux 没有动作 | wmux 界面可能尚未初始化，或会话已停止；先在 wmux 中打开窗口并重新执行 `LIST` |
| 不希望机器人读取群内所有消息 | 当前命令可不 @ 机器人，因此必须申请群消息权限。若企业安全策略不允许，应将实现改为“仅 @机器人触发”，再使用更小的 @消息权限 |

请将此群限定为管理群，并只把可信操作者的 Open ID 加入白名单。

### 本次接入中遇到的问题

| 现象 | 原因 | 处理方式 |
| --- | --- | --- |
| 单聊发送 `WMUX SUPERVISOR LIST` 没有回复，日志出现 `dm_disabled` | 旧进程只允许群聊，或仍在使用旧版本 | 使用支持单聊白名单的版本，确认发送者 Open ID 已加入 `WMUX_FEISHU_ALLOWED_OPEN_IDS`，然后重启 wmux。 |
| 单聊能收到回复，但审计消息没有到预期位置 | `WMUX_FEISHU_CHAT_ID` 填成了单聊 ID，或修改环境变量后没有重启 | 将 `WMUX_FEISHU_CHAT_ID` 设置为实际审计群的 `oc_...` ID；人工决策单聊 ID 单独填写到 `WMUX_FEISHU_DECISION_CHAT_ID`；完整重启 wmux 后重测。 |
| 日志有 `[ws] ws client ready`，但命令仍无结果 | 这只表示长连接已建立，不代表事件、权限和访问策略均正确 | 检查 `im.message.receive_v1` 已发布、消息权限已开通，并检查单聊白名单或审计群 ID。 |
| 本地监督终端提示 `TERM is set to "dumb"`，Codex 拒绝启动交互界面 | 旧 Electron/终端进程继承了 `TERM=dumb` | 使用包含 TERM 修复的 wmux 并重启；停止旧监督会话后新建会话。不要在旧提示中输入 `y`，该会话无法靠确认恢复。 |

## 8. 人工审批如何流转

非决策类监督审计事件会按发生顺序实时推送到审计群；为避免飞书群机器人限流，wmux 会以约 220 毫秒的最小间隔顺序发送。路径、凭据字段和常见令牌会脱敏，终端屏幕全文不会发送。监督 AI 提交 `needs-human` 时，配置的决策单聊（或最近有效的白名单用户单聊）会收到可批准、暂停或停止的审批卡片；卡片与处理结果都不会发送到审计群，并会同步回 wmux 的当前监督会话。

飞书任务输入受 Open ID 白名单、单聊/独立控制群访问策略和当前终端 ID 校验保护；由于 `SEND` 与“批准并发送任务”会实际向终端输入并提交内容，请仅向可信用户授予白名单权限。AI 自主监督仍不会绕过关键风险限制。
