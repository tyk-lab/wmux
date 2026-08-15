<h1 align="center">wmux</h1>
<p align="center">Windows 上的 AI 终端复用器 —— 侧栏实时看清代理是否在忙、是否在等你</p>

<p align="center">
  <a href="https://github.com/amirlehmam/wmux"><img src="https://img.shields.io/badge/platform-Windows-0078D4?logo=windows" alt="Windows" /></a>
  <a href="https://github.com/amirlehmam/wmux/releases"><img src="https://img.shields.io/github/v/release/amirlehmam/wmux?label=release&color=555" alt="Release" /></a>
  <a href="https://github.com/amirlehmam/wmux/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-555" alt="License" /></a>
</p>

wmux 是基于 Electron + xterm.js 的 Windows 终端复用器，专为 AI 代理设计：分屏窗格、内置浏览器、**声明式侧栏 Agent 状态**（Working / Needs you / Idle），以及命名管道 + CLI 可编程接口。

兼容 Claude Code、OpenCode、Codex、Kimi、Pi Agent 等终端 agent；有官方 Hook/扩展事件的自动上报，没有的用 `wmux wrap` 做进程级状态。

## 快速启动

### 方式一：下载安装包（推荐）

从 [GitHub Releases](https://github.com/amirlehmam/wmux/releases/latest) 下载最新的 `wmux-<版本号>-setup.exe`，运行安装程序，然后从开始菜单或桌面快捷方式启动 wmux。

> **注意：** 如果 Windows SmartScreen 弹出警告，点击 **"更多信息" → "仍要运行"** 即可（发布产物尚未进行 Authenticode 代码签名）。

### 方式二：从源码运行（开发模式）

**前置条件：**

- Windows 10/11
- Node.js 18+（推荐 LTS 版本）
- 用于编译 `node-pty` 的 C++ 构建工具链 —— 安装 Visual Studio Build Tools，并勾选 "使用 C++ 的桌面开发" 工作负荷

**步骤：**

```bash
git clone https://github.com/amirlehmam/wmux.git
cd wmux
npm ci          # 按 package-lock.json 精确安装依赖
npm run dev     # 启动 Vite（端口 5199）并拉起 Electron
```

Vite 就绪后应用窗口会自动打开。渲染进程代码修改后支持热更新；修改主进程代码后需重启 `npm run dev`。

> **开发时验证 Agent 侧栏：** 改完主进程 / CLI 后需 `npm run build:main` 并**重启** wmux；只热更渲染进程不会带上 `report-agent` / `wrap` 链路。

#### 日常重新编译

在仓库根目录执行：

```powershell
npm run build:main      # 重新编译主进程、preload 和 CLI
npm run build:renderer  # 重新编译 React Renderer
```

修改主进程、preload 或 CLI 后，需要停止并重新运行 `npm run dev`；仅修改 Renderer 时，开发模式通常会自动热更新。

## 环境变量与敏感配置（必读）

`docs/env.txt` 包含飞书 / Lark 等第三方服务的敏感凭据（App ID、App Secret、会话 ID 等），**仅限本地开发使用，绝不能提交到远程仓库**。该文件已加入忽略列表，如果你从其他地方复制了它，请确认：

- 不要把它打包进 `release/` 或安装包。
- 不要通过截图、粘贴、PR 等方式泄露其内容。
- 生产环境应改用环境变量或私密配置管理工具，而不是仓库内的文本文件。

## 侧栏 Agent 状态

左侧工作区行显示本会话代理状态（优先级从高到低）：

> 本节只覆盖日常开发与使用；完整的 Hook 协议与 CLI 细节见 `CLAUDE.md`。

| 状态 | 含义 |
|------|------|
| **Needs you** | 等你确认权限 / 回答问题（blocked） |
| **Working** | 本轮任务在跑（Hook / `report-agent` / `wrap`） |
| **Running** | 仅 shell 有前台命令（非 agent 声明） |
| **Idle** | 空闲 |

**设计原则（少猜、多声明）：** 生命周期真相由各 agent 的 **Hook 固定上报**，wmux 只收信改状态；不解析 TUI、不用模型判断「忙不忙」。窗格内已注入 `WMUX_SURFACE_ID` / `WMUX_PIPE` / `WMUX_PIPE_TOKEN`，CLI 默认识别当前 surface。

### 安装 / 刷新 Agent Hooks（脚本）

#### 何时需要跑脚本

| 场景 | 是否需要 |
|------|----------|
| 首次从源码开发 / 刚拉代码 | **需要** `npm run install:hooks` |
| 日常启动 wmux（已装过 hooks） | 启动时会再 ensure 一遍；也可手动刷新 |
| 改过 hook 注入逻辑 / 升级 wmux | **再跑一次** install-hooks，并**重启各 agent** |
| 只改了渲染层 UI | 不必重装 hooks |

#### 怎么跑

在**仓库根目录**：

```powershell
# 推荐：缺 dist 时会先 npm run build:main，再写入各家配置
npm run install:hooks

# 等价
node scripts/install-agent-hooks.mjs
pwsh -File scripts/install-agent-hooks.ps1

# 已编译过 CLI 时
node dist/cli/wmux.js install-hooks
wmux install-hooks          # PATH 已指向本仓库 dist/cli 时
```

若当前运行的是本地解压版 wmux，安装脚本会自动优先识别
`%LOCALAPPDATA%\wmux-build\release\win-unpacked\wmux.exe`，并将各 Agent 的 Hook
指向同目录的 `resources\cli\wmux-hook.js`。也可显式指定其他 wmux：

```powershell
pwsh -File scripts/install-agent-hooks.ps1 -WmuxExe "$env:LOCALAPPDATA\wmux-build\release\win-unpacked\wmux.exe"
node scripts/install-agent-hooks.mjs --wmux-exe "$env:LOCALAPPDATA\wmux-build\release\win-unpacked\wmux.exe"
```

未找到解压版且未指定路径时，脚本回退为仓库的 `dist\cli\wmux-hook.js`。

| 参数 | 适用 | 含义 |
|------|------|------|
| `--no-opencode` | mjs / ps1 / `wmux install-hooks` | 不安装 OpenCode 插件 |
| `--skip-build` | 仅 mjs / ps1 | 不自动 `build:main`（要求已有 `dist/cli/wmux.js`） |
| `--wmux-exe <路径>` / `-WmuxExe <路径>` | mjs / ps1 | 指定当前使用的 `wmux.exe`，Hook 写入其 `resources\cli` |

#### 脚本会写什么

幂等：可重复执行；**不会删除**你自己的非 wmux hooks（仅替换带 `wmux-hook` 的条目 / 标记块）。

| 目标 | 路径 | 备注 |
|------|------|------|
| Claude Code | `~/.claude/settings.json` | 无文件时会创建空 `{}` 再写入 |
| Kimi Code | `~/.kimi-code/config.toml` | `# wmux-hooks:start/end` 标记块 |
| Codex CLI | `~/.codex/hooks.json` | 可能需在 Codex 里 `/hooks` **信任** |
| Grok Build | `~/.grok/hooks/wmux.json` | 全局 hooks，始终可信 |
| Pi Agent | `~/.pi/agent/extensions/wmux-agent-hooks.ts` | 独立全局扩展；通过原生生命周期事件上报 |
| OpenCode | `~/.config/opencode/plugin/wmux.js` | 可用 `--no-opencode` 跳过 |

每条 hook 命令形如：

```text
node "<仓库>/dist/cli/wmux-hook.js" --event Stop --agent Kimi
```

- `--event`：生命周期（Working / Idle / Needs you）  
- `--agent`：通知与侧栏展示用的产品名（**写死在安装配置里**，不靠目录名猜测）  
- `WMUX_SURFACE_ID`：由 wmux 注入，绑定窗格  

成功时终端打印 `[OK] Claude Code` / `Kimi` / … 与路径；有 `[FAIL]` 则退出码非 0。

#### 安装后必做

1. **重启 wmux**（若刚编过 main/renderer）  
2. **重启每个 agent 会话**（claude / kimi / codex / grok / pi），否则仍用旧 hooks  
3. Codex：打开 `/hooks`，信任含 `wmux-hook` 的命令（首次）  

### 支持矩阵（turn 级）

| Agent | 配置落点 | 窗格内用法 | 备注 |
|-------|----------|------------|------|
| **Claude Code** | `~/.claude/settings.json` | `claude` | 保留用户 hooks |
| **Kimi Code** | `~/.kimi-code/config.toml` | `kimi` | 标记块管理 |
| **Codex CLI** | `~/.codex/hooks.json` | `codex` | 需 trust hooks |
| **Grok Build** | `~/.grok/hooks/wmux.json` | `grok` | 全局可信 |
| **Pi Agent** | extension `wmux-agent-hooks.ts` | `pi` | 原生扩展事件 |
| **OpenCode** | plugin `wmux.js` | `opencode` | 插件 API |

**事件 → 侧栏（固定映射，无 AI 判断）：**

| Hook | 侧栏 |
|------|------|
| `UserPromptSubmit` | **Working** |
| `PostToolUse` | **Working** |
| `Notification` / `PermissionRequest` | **Needs you** |
| `Stop` / `StopFailure` | **Idle** |
| `SubagentStop` | 子代理结束（refcount） |

### 通知

铃铛面板每条三行：

```text
Session 2                         ← 工作区 / 会话名
Turn complete · Kimi · tyk          ← 状态 · agent(hook) · 终端名
just now                          ← 时间
```

- **agent**：来自 hook 的 `--agent`（如 Kimi），不是猜的  
- **终端名**：窗格/标签名（如你改成的 `tyk`），用于多 pane 区分  
- 标题栏 **Clear all**：清空全部通知并重置未读角标；**Mark read** 仅标已读  

正在注视该工作区时，「回合结束」类通知会跳过（侧栏已能看到 Idle）；「需要输入」仍会通知。

### 没有 Hook 的 Agent：`wmux wrap`

无扩展点时用进程级包装（只能知道进程在/不在，不是 turn 级）：

```powershell
wmux wrap --label other -- some-agent
```

### 手动上报（自建 harness）

```powershell
wmux report-agent --run-start          # 或 --run-depth 1
wmux report-agent --blocked "permission: Bash"
wmux report-agent --unblocked
wmux report-agent --run-depth 0
wmux release-agent
wmux agent-state
```

### 排障

| 现象 | 处理 |
|------|------|
| 侧栏/通知无 agent 名 | 再跑 `npm run install:hooks`，确认命令含 `--agent`，**重启 agent** |
| 侧栏一直 Running | 那是 shell 态；turn 级应显示 Working/Idle（需 hooks 生效） |
| Codex 无 Working | `/hooks` 信任 `wmux-hook` 后重启 codex |
| `wrap: no surface id` | 必须在 **wmux 窗格内** 执行 |
| `could not report agent state` | 使用含 agent-state 的构建并重启 wmux |
| install-hooks 指向错误路径 | 在本仓库根目录执行；成功后 hook 路径应为当前仓库的 `dist/cli/wmux-hook.js` |

## 编译 Windows 可执行文件

确认已按「方式二：从源码运行」完成克隆和 `npm ci` 后，执行完整编译与打包：

```bash
npm run build     # 编译 + 打包，产出 NSIS 安装包
```

`npm run build` 实际调用 `node scripts/build-package.mjs`，顺序为：

```bash
# ① 清理旧打包句柄 / win-unpacked 残留（scripts/clear-package-locks.mjs）
# ② tsc -p tsconfig.node.json          → dist/（主进程 / preload / CLI）
# ③ vite build                         → dist/renderer/
# ④ 再次清锁（长编译期间同步软件可能重新占住文件）
# ⑤ electron-builder（经 scripts/electron-builder-safe.mjs）
```

如需分步调试，也可单独执行 `npm run build:main`（仅步骤②）或 `npm run build:renderer`（仅步骤③）。

### 编译打包相关脚本

| 命令 | 作用 |
|------|------|
| `npm run build` | 清锁 → 完整编译 → 打 NSIS 安装包 |
| `npm run package:exe` | 只清锁 + 打包（不重新编译 `dist/`） |
| `npm run build:clear` | 仅清理旧句柄与 `win-unpacked*` 残留 |

对应实现：

| 脚本 | 说明 |
|------|------|
| `scripts/build-package.mjs` | 编译打包入口；支持 `--package-only` 跳过 tsc/vite |
| `scripts/clear-package-locks.mjs` | 结束占用 `release\` 的打包进程，重试删除/挪开 `win-unpacked*` |
| `scripts/electron-builder-safe.mjs` | 包装 electron-builder，规避同步盘上的 `EBUSY` |

**为何需要清锁：** Windows 上 VerySync / OneDrive、杀毒或上次从 `release\win-unpacked` 启动的 wmux 可能占住 `.asar`，导致 electron-builder 报 `EBUSY: resource busy or locked`。清锁脚本会结束**仅位于打包输出目录内**的 `wmux` / `elevate` 等进程，并尽量删掉或 rename 残留目录。

### 产物位置（本地 Windows 必看）

默认配置只打 **NSIS 安装包**（`wmux-<版本>-setup.exe`），**不会**在项目 `release/` 根目录生成裸 `wmux.exe`。

为避开同步盘（VerySync / OneDrive 等）对 `.asar` 的 `EBUSY` 锁定，本地打包分两层目录：

| 用途 | 路径 | 说明 |
|------|------|------|
| **分发 / 安装** | 仓库内 `release\wmux-<版本>-setup.exe` | 打包成功后从本地目录**复制回来**的安装包 |
| **同上（原始产出）** | `%LOCALAPPDATA%\wmux-build\release\wmux-<版本>-setup.exe` | electron-builder **真正写出**的位置（与上面文件相同） |
| **本机免安装直接跑** | `%LOCALAPPDATA%\wmux-build\release\win-unpacked\wmux.exe` | 解压后的应用主程序；**只在这里**，不拷回仓库 |
| **完整解压目录** | `%LOCALAPPDATA%\wmux-build\release\win-unpacked\` | 含 `wmux.exe`、resources 等；本地调试可整夹运行 |
| **勿用（旧残留）** | 仓库内 `release\win-unpacked`、`release\win-unpacked.tmp` | 历史失败/旧构建常被同步软件锁住删不掉，**不是**当前成功构建结果，不要从这里启动 |

PowerShell 快速打开：

```powershell
# 仓库内安装包
explorer.exe .\release

# 本地真实打包目录（setup.exe + win-unpacked）
explorer.exe "$env:LOCALAPPDATA\wmux-build\release"

# 免安装启动
& "$env:LOCALAPPDATA\wmux-build\release\win-unpacked\wmux.exe"
```

示例（版本以 `package.json` 为准，例如 `0.39.1`）：

```text
# 安装包（两处各一份）
<仓库>\release\wmux-0.39.1-setup.exe
%LOCALAPPDATA%\wmux-build\release\wmux-0.39.1-setup.exe

# 免安装主程序（仅本地）
%LOCALAPPDATA%\wmux-build\release\win-unpacked\wmux.exe
```

**CI**（`GITHUB_ACTIONS` / `CI`）仍直接把全部产物写到仓库 `release/`，不经 `%LOCALAPPDATA%`。

可用环境变量覆盖本地打包根目录（替代默认的 `%LOCALAPPDATA%\wmux-build\release`）：

```powershell
$env:WMUX_BUILD_OUT = "D:\temp\wmux-release"
npm run build
# 则 setup.exe / win-unpacked 在 D:\temp\wmux-release\
# 安装包仍会尝试复制到仓库 release\
```

若日志仍提示 `still locked`，可：暂停对该仓库的同步、关闭从旧 `release\win-unpacked` 启动的 wmux，或把 `release/` 加入同步忽略列表后再执行 `npm run build:clear`。

### 只更新安装包 exe

若 `dist/` 已是当前代码的编译结果，只需重新生成 `wmux-<版本号>-setup.exe` 时，运行：

```powershell
npm run package:exe
```

该命令走 `build-package.mjs --package-only --win nsis`：**会清锁并打包**，但**不会**重新编译主进程、preload、CLI 或 React 渲染进程。若刚修改过源码，先按改动范围更新 `dist/`，再执行打包：

```powershell
# 改了 src/main/、src/preload/ 或 src/cli/
npm run build:main

# 改了 src/renderer/
npm run build:renderer

# 仅重新打包（位置见上一节「产物位置」）
npm run package:exe
```

仓库 `release/` 中与安装相关的文件：

| 产物 | 说明 |
|------|------|
| `wmux-<版本号>-setup.exe` | NSIS 安装包（开始菜单 / 桌面快捷方式，可改安装目录） |
| `wmux-<版本号>-setup.exe.blockmap` | 增量更新用块图 |
| `latest.yml` | electron-updater 元数据 |
| `win-unpacked*` | 若存在，多半是旧残留，见上表「勿用」 |

### 更多打包命令

已编译过 `dist/` 后，可用安全包装脚本或 electron-builder 生成其他格式：

```bash
npm run package:exe                                      # NSIS 安装包（与 npm run build 的最终产物相同）
node scripts/electron-builder-safe.mjs --win portable    # 便携版（本地同样避开同步盘 EBUSY）
npx electron-builder --win zip                           # zip 压缩包（直接写项目 release/，同步盘上可能 EBUSY）
npx electron-builder --dir                               # 未打包目录（同上，同步盘需谨慎）
```

> 注意：单独执行 `npx electron-builder ...` 前需先跑过 `npm run build:main` 和 `npm run build:renderer`（或一次完整的 `npm run build`），否则 `dist/` 不存在会打包失败。在同步盘上的仓库优先用 `npm run build` / `package:exe` / `electron-builder-safe.mjs`。

打包配置（目标格式、图标、随包资源等）见 `electron-builder.json`。

## 其他常用命令

```bash
npm test            # 运行 Vitest 测试套件
npm run typecheck   # 检查渲染进程与主进程的 TypeScript 类型
npm run lint        # 对 src/ 目录执行 ESLint
```

## 许可证

wmux 基于 [MIT 许可证](LICENSE) 开源。它是受 [cmux](https://github.com/manaflow-ai/cmux) 启发的独立重写实现，未使用 cmux 的源代码。
