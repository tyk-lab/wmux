<h1 align="center">wmux</h1>
<p align="center">Windows 下的 Claude Code 可视化层——实时查看 AI Agent 的行为</p>

<p align="center">
  基于 Electron + xterm.js 构建，来源于 <a href="https://github.com/manaflow-ai/cmux">cmux</a> 的分支实现。
</p>

<p align="center">
  <a href="https://github.com/amirlehmam/wmux"><img src="https://img.shields.io/badge/platform-Windows-0078D4?logo=windows" alt="Windows" /></a>
  <a href="https://github.com/amirlehmam/wmux/releases"><img src="https://img.shields.io/github/v/release/amirlehmam/wmux?label=release&color=555" alt="Release" /></a>
  <a href="https://github.com/amirlehmam/wmux/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-555" alt="License" /></a>
</p>

<p align="center">
  <img src="https://wmux.org/assets/wmux-full.png" alt="wmux — 带浏览器面板的终端复用器" width="900" />
</p>

## 特性

<table>
<tr>
<td width="40%" valign="middle">
<h3>被动式 Claude Code 集成</h3>
wmux 在不改变 Claude Code 工作方式的前提下观察其运行状态。会自动在 <code>~/.claude/settings.json</code> 中注入钩子，将 Agent 与工具活动上报到侧边栏。<code>localhost:9222</code> 上的 CDP 代理使 Claude Code 的原生 <code>chrome-devtools-mcp</code> 插件可直接控制 wmux 的浏览器面板。启动后会自动完成配置，几乎无需手工设置。
</td>
<td width="60%">
<img src="./docs/assets/wmux-sidebar.png" alt="显示活动 Claude Code 会话的侧边栏" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>实时浏览器可视化</h3>
Claude Code 的网页操作会实时同步到 wmux 浏览器面板。页面跳转、点击、输入、截图都可见；Claude Code 仍按自身工具工作，wmux 只负责展示。面板同样会在终端与 Markdown 中打开链接。
</td>
<td width="60%">
<img src="./docs/assets/wmux-browser.png" alt="浏览器面板实时展示网页操作" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>活动指示器</h3>
侧边栏的状态点会直观反映各会话状态：<b>橙色脉冲</b> 表示运行中，<b>绿色</b> 表示完成，<b>红色</b> 表示中断（Ctrl+C）。还会实时展示 Git 分支、脏文件状态、工作目录与 PR 状态。
</td>
<td width="60%">
<img src="./docs/assets/wmux-sidebar.png" alt="带实时活动指示器的侧边栏" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>通知中心</h3>
Agent 完成或需要关注时会触发面板蓝色环及标签高亮，并支持 OSC 9 / 99 / 777、<code>wmux notify</code> 命令以及空闲检测。点击铃铛图标可查看待处理通知并一键跳转，支持 Windows Toast 与任务栏闪烁提醒。
</td>
<td width="60%">
<img src="./docs/assets/wmux-notification.png" alt="显示未处理通知的面板" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Shell 标签</h3>
终端标签会自动识别并显示当前 Shell（PowerShell、bash、zsh、cmd），无需额外配置。多 Agent 并行时可快速区分各面板。
</td>
<td width="60%">
<img src="./docs/assets/wmux-shell-labels.png" alt="带 Shell 标签的标签栏" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>主题与配色</h3>
内置 450+ Ghostty 主题与 17 套 wmux 主题。可在 <code>~/.wmux/config.toml</code> 配置全局默认配色，或在拆分时通过 <code>wmux split --color-scheme NAME</code> 覆盖；还可在设置中定义自定义命名方案，并可从 Windows Terminal / Ghostty 导入。
</td>
<td width="60%">
<img src="./docs/assets/wmux-themes.png" alt="设置面板中的主题列表" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>wmux-orchestrator 插件</h3>
内置的 Claude Code 插件可将复杂任务拆解为并行执行的子 Agent，按依赖关系分阶段调度，每个 Agent 在独立 wmux 终端窗格中运行，并支持复核与自动修复。通过 <code>/wmux:orchestrate</code> 激活，无需守护进程和额外密钥。
</td>
<td width="60%">
<img src="./docs/assets/wmux-terminals.png" alt="多个并行 Agent 运行在分屏终端中" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>纵向 / 横向分屏</h3>
可向右或向下拆分任意窗格，拖动分隔条调整比例。使用 <code>Ctrl+Shift+Enter</code> 可放大当前窗格。每个窗格支持多标签，全部标签通过 <code>visibility: hidden</code> 保持 PTY 存活，切换不会断连。工作区布局会持久化。
</td>
<td width="60%">
<img src="./docs/assets/wmux-terminals.png" alt="纵向与横向分屏布局" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>会话恢复</h3>
一键保存并恢复整个工作区布局（分屏、工作目录、浏览器 URL、Shell 类型）。重启后会自动恢复上次会话，避免重复手工 <code>cd</code> 与分屏。
</td>
<td width="60%">
<img src="./docs/assets/wmux-sidebar.png" alt="侧边栏中的会话保存与加载" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>剪贴板图片粘贴</h3>
复制截图后在 wmux 终端中按 <code>Ctrl+V</code> 即可，图片会写入临时文件并注入路径，Claude Code 可直接读取，与网页端粘贴体验一致。
</td>
<td width="60%">
<img src="./docs/assets/wmux-full.png" alt="截图粘贴流程" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>首次启动教程</h3>
7 步交互式引导覆盖工作区、分屏、标签、浏览器面板与通知，帮助新用户两分钟内上手。可随时通过标题栏 <code>?</code> 按钮重新打开。
</td>
<td width="60%">
<img src="./docs/assets/wmux-tutorial.png" alt="首次引导教学界面" width="100%" />
</td>
</tr>
</table>

- **更新提示徽标**：标题栏徽标会提示新版本发布，点击可打开 Release 页面；未内置自动更新与后台下载。
- **链接可点击**：终端和 Markdown 中的 URL 可直接在 wmux 浏览器面板打开，支持 Ctrl+点击或直接点击（可配置）。
- **可编排**：基于命名管道（<code>\\.\pipe\wmux</code>）的 JSON-RPC API，可编程创建工作区、拆分窗格、发送按键、读取终端内容、控制浏览器与启动子 Agent。
- **原生体验**：采用 ConPTY，支持 Windows 通知与任务栏闪烁，含原生标题栏覆盖层。
- **兼容 Windows Terminal / Ghostty**：可导入主题、字体与配色；内置 450+ Ghostty 主题。
- **GPU 加速**：xterm.js WebGL 渲染，终端大量输出也能保持流畅。

## 安装

### 下载（推荐）

从 GitHub Releases 下载最新的 `wmux-*-win-x64.zip`，解压后直接运行 `wmux.exe`。无安装器、无代码签名、无需管理员权限。

> **说明：** 若解压后出现 SmartScreen 提示，可先对 zip 右键选择 **Unblock**，再解压并运行。

### 从源码安装

```bash
git clone https://github.com/amirlehmam/wmux.git
cd wmux
npm install
npm run dev
```

如需生成本地打包产物：

```bash
npm run build
```

构建结果位于 `release/win-unpacked/wmux.exe`。注意：Electron 应用可执行文件名必须是 `wmux.exe`；`psmux.exe` 是系统全局可用的 psmux 会话工具，wmux 会在终端会话管理时调用它。

## 为什么是 wmux？

我会同时运行很多 Claude Code 会话。macOS 上有 [cmux](https://github.com/manaflow-ai/cmux) 提供了我需要的纵向标签、实时元数据、通知提醒和脚本化浏览器能力；但在 Windows 上并没有对应方案。

Windows Terminal 有标签页却没有完备通知机制，只能逐个检查；tmux 在 WSL 可用，但丢失原生 Windows 集成；现有 Electron 终端也缺乏 AI 协作场景的完整工作流。

因此我做了 wmux：它不替代 Claude Code，也不改变 Claude Code 的行为，只做可视化增强。`localhost:9222` 上的 CDP 代理让 Claude Code 浏览器工具直接驱动 wmux 浏览器面板，你可以实时看到每次页面加载、点击与表单输入。`settings.json` 中的自动注入 hooks 负责上报工具调用、分支、终端状态等到侧边栏。

首次启动时，wmux 会自动配置 `~/.claude/settings.json` 中的 hooks，安装 wmux-orchestrator 插件，并启动 CDP 代理；不会自动改写 Claude Code 或 Codex/OpenCode 的全局提示词文件。无需额外 API Key，只要现有 Claude Code 会话即可。

所有能力均可通过 `wmux` CLI 或命名管道自动化，CLI 协议与 cmux 兼容。

## wmux-orchestrator

wmux 内置一个 Claude Code 插件，可并行协调多个可见终端中的 Agent。任意 Claude Code 会话输入 `/wmux:orchestrate` 即可激活。

**功能：**
1. 分析当前代码库并将任务拆解为独立工作单元
2. 将每个单元分配给独立终端窗格中的 Claude Code Agent
3. 按依赖关系分阶段执行，前置步骤完成后再推进下一波
4. Reviewer Agent 审核汇总结果并触发自动修复

**插件命令：**
```
/wmux:orchestrate   将复杂任务自动分解并并行执行
```

插件会自动安装到 `~/.claude/plugins/cache/`（wmux 启动时）。也可单独使用： [plugin.wmux.org](https://plugin.wmux.org) · [github.com/amirlehmam/wmux-orchestrator](https://github.com/amirlehmam/wmux-orchestrator)

## Shell 集成

wmux 会自动注入到以下 shell：

- **PowerShell**：覆盖 `prompt`，上报 CWD、git 分支、脏文件状态与 shell 状态；借助 PSReadLine 的 preexec 在命令开始时触发；支持 45 秒轮询 `gh pr view`。
- **CMD**：通过 `PROMPT` 中注入 OSC 9 上报 CWD。
- **Bash/Zsh (WSL)**：使用 `PROMPT_COMMAND` / `precmd` + `preexec`，通过退出码 130 识别中断；通过临时文件桥接上报。

共用环境变量：

| 变量 | 说明 |
|----------|-------------|
| `WMUX` | 终端内恒为 `1` |
| `WMUX_CLI` | wmux CLI 脚本路径 |
| `WMUX_SURFACE_ID` | 当前面板（surface）ID |
| `WMUX_PIPE` | 命名管道路径（`\\.\pipe\wmux`） |

## 快捷键

所有快捷键可在设置中修改（`Ctrl+,`）。

### 工作区

| 快捷键 | 操作 |
|----------|--------|
| Ctrl+N | 新建工作区 |
| Ctrl+1–8 | 跳转到 1–8 号工作区 |
| Ctrl+9 | 跳转到最后一个工作区 |
| Ctrl+PageDown | 下一个工作区 |
| Ctrl+PageUp | 上一个工作区 |
| Ctrl+Shift+W | 关闭当前工作区 |
| Ctrl+Shift+R | 重命名工作区 |
| Ctrl+B | 切换侧边栏 |

### 窗格（Surfaces，标签页）

| 快捷键 | 操作 |
|----------|--------|
| Ctrl+T | 新建 surface |
| Ctrl+Shift+] | 下一个 surface |
| Ctrl+Shift+[ | 上一个 surface |
| Alt+1–8 | 跳转到 1–8 号 surface |
| Ctrl+W | 关闭当前 surface |

### 分屏窗格

| 快捷键 | 操作 |
|----------|--------|
| Ctrl+D | 向右拆分 |
| Ctrl+Shift+D | 向下拆分 |
| Ctrl+Alt+方向键 | 方向聚焦窗格 |
| Ctrl+Shift+Enter | 切换当前窗格放大 |
| Ctrl+Shift+H | 闪烁当前面板 |

### 浏览器

| 快捷键 | 操作 |
|----------|--------|
| Ctrl+Shift+I | 开关浏览器面板 |
| Ctrl+Alt+I | 开关开发者工具 |
| Ctrl+Alt+C | 显示 JS 控制台 |

### 通知

| 快捷键 | 操作 |
|----------|--------|
| Ctrl+Alt+N | 开关通知面板 |
| Ctrl+Shift+U | 跳转到最新未读 |

### 查找

| 快捷键 | 操作 |
|----------|--------|
| Ctrl+F | 打开查找 |
| Enter / Shift+Enter | 下一个 / 上一个 |
| Escape | 关闭查找 |

### 终端

| 快捷键 | 操作 |
|----------|--------|
| Ctrl+Shift+C | 复制 |
| Ctrl+Shift+V | 粘贴 |
| Ctrl+V | 粘贴（文本或截图路径） |
| Ctrl+C | 有选中内容时复制 / 无选中时中断 |
| Ctrl+= / Ctrl+- | 放大 / 缩小字体 |
| Ctrl+0 | 重置字体大小 |

### 窗口

| 快捷键 | 操作 |
|----------|--------|
| Ctrl+Shift+N | 新建窗口 |
| Ctrl+, | 设置 |
| Ctrl+Shift+P | 命令面板 |

## CLI

`wmux` CLI 与运行中的应用通过命名管道通信：

```bash
wmux ping                          # 检查 wmux 是否在运行
wmux notify "Build complete"       # 发送通知
wmux new-workspace --title "API"   # 新建工作区
wmux list-workspaces               # 列出所有工作区
wmux split --right                 # 向右拆分当前窗格
wmux send "npm test"               # 向终端发送文本
wmux send-key Enter --ctrl         # 发送按键
wmux read-screen --lines 50         # 读取终端内容

# 浏览器（CDP）
wmux browser open http://localhost:3000
wmux browser snapshot              # 可访问树（含 @eN 引用）
wmux browser click @e5             # 按引用点击元素
wmux browser type @e3 "hello"      # 按引用输入文本
wmux browser fill @e3 "value"      # 按引用设置输入值
wmux browser screenshot            # 截图，返回 Base64 PNG
wmux browser eval "document.title"  # 执行 JavaScript

# Agent
wmux agent spawn --cmd "claude --resume abc" --label "Research"
wmux agent spawn-batch --json '[{"cmd":"claude","label":"Agent 1"},{"cmd":"claude","label":"Agent 2"}]'
wmux agent list                    # 列出所有 Agent
wmux agent status <agent-id>       # 查看 Agent 状态
wmux agent kill <agent-id>         # 结束 Agent

wmux tree                          # 工作区 / 窗格 / surface 层级
```

## Socket API

连接 `\\.\pipe\wmux` 进行编程控制，支持两种协议：

**V1**（文本，供 Shell 集成使用）：
```
report_pwd <surface_id> <path>
report_git_branch <surface_id> <branch> [dirty]
report_shell_state <surface_id> idle|running|interrupted
notify <surface_id> <text>
ping
```

**V2**（JSON-RPC，供 CLI 与自动化使用）：
```json
{"method": "workspace.create", "params": {"title": "Agent 1"}}
{"method": "workspace.list", "params": {}}
{"method": "surface.send_text", "params": {"id": "surf-...", "text": "npm test\n"}}
{"method": "surface.read_text", "params": {"id": "surf-...", "lines": 50}}

// 浏览器控制（CDP）
{"method": "browser.navigate", "params": {"url": "http://localhost:3000"}}
{"method": "browser.snapshot", "params": {}}
{"method": "browser.click", "params": {"ref": "@e5"}}
{"method": "browser.screenshot", "params": {"fullPage": true}}
{"method": "browser.eval", "params": {"js": "document.title"}}

// Agent 管理
{"method": "agent.spawn", "params": {"cmd": "claude --resume abc", "label": "Research"}}
{"method": "agent.spawn_batch", "params": {"agents": [...], "strategy": "distribute"}}
{"method": "agent.list", "params": {}}
{"method": "agent.kill", "params": {"agentId": "agent-..."}}

{"method": "system.tree", "params": {}}
```

## 会话恢复

重启后 wmux 会恢复：

- 窗口位置与大小
- 工作区布局（标题、配色、置顶状态）
- 分屏结构（方向和比例）
- 各终端工作目录
- 每个终端默认 shell
- 浏览器面板 URL
- 当前活动工作区与窗格

wmux 不会恢复正在运行的进程状态。重启后不会继续保留 Claude Code、tmux、vim 等会话，终端会在对应目录下重新拉起 shell。

## 配置

### 终端主题

在 `~/.wmux/config.toml` 配置全局默认主题：

```toml
[terminal]
color_scheme = "Dracula"
```

在拆分时或运行时覆盖面板主题：

```bash
wmux split --color-scheme "Tokyo Night"
wmux set-color-scheme "Solarized Dark"
```

在设置面板中也可定义自定义命名主题（Terminal > Custom Schemes）。

### 从现有终端配置导入

wmux 支持从以下配置导入：

1. **Windows Terminal** — `%LOCALAPPDATA%\\Packages\\Microsoft.WindowsTerminal_...\\LocalState\\settings.json`
2. **Ghostty** — `~/.config/ghostty/config`

在设置页（Settings → Terminal → Import）导入，可提取字体、字号、配色方案与调色板。默认主题为 Dracula，内置 450+ Ghostty 主题。

## 架构

采用 Electron 双进程模型。主进程负责 PTY 启动（node-pty/ConPTY）、命名管道、CDP 桥接、端口扫描、git/PR 轮询、通知、Claude Code 上下文注入、会话持久化与窗口生命周期。渲染进程负责 React/Zustand 与 xterm.js（WebGL）界面，以及递归式分屏、侧边栏等核心 UI。

```
src/
  main/               # Electron 主进程
  renderer/           # React 界面（侧边栏、分屏、终端、浏览器）
  preload/            # contextBridge API（window.wmux）
  cli/                # wmux CLI
  shared/             # 主进程与渲染进程共享类型
  shell-integration/  # PowerShell、CMD、bash/zsh 集成脚本

resources/
  wmux-orchestrator/  # 内置 Claude Code 插件（启动时自动安装）
  themes/             # Ghostty 与 wmux 主题
  sounds/             # 通知音效
```

## 基于 cmux

wmux 是 cmux 在 Windows 的重实现。设计理念、socket 协议与使用方式基本一致，许多面向 cmux 的工具也可直接用于 wmux。

## 贡献

- [GitHub Issues](https://github.com/amirlehmam/wmux/issues) — 报告缺陷与建议新功能
- [GitHub Discussions](https://github.com/amirlehmam/wmux/discussions) — 提问与讨论

## 许可证

wmux 使用 [AGPL-3.0-or-later](LICENSE) 开源许可。
