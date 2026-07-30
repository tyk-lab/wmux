<h1 align="center">wmux</h1>
<p align="center">Windows 上的 AI 终端复用器 —— 侧栏实时看清代理是否在忙、是否在等你</p>

<p align="center">
  <a href="https://github.com/amirlehmam/wmux"><img src="https://img.shields.io/badge/platform-Windows-0078D4?logo=windows" alt="Windows" /></a>
  <a href="https://github.com/amirlehmam/wmux/releases"><img src="https://img.shields.io/github/v/release/amirlehmam/wmux?label=release&color=555" alt="Release" /></a>
  <a href="https://github.com/amirlehmam/wmux/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-555" alt="License" /></a>
</p>

wmux 是基于 Electron + xterm.js 的 Windows 终端复用器，专为 AI 代理设计：分屏窗格、内置浏览器、**声明式侧栏 Agent 状态**（Working / Needs you / Idle），以及命名管道 + CLI 可编程接口。

兼容 Claude Code、OpenCode、Codex、Kimi 等终端 agent；有官方 Hook 的自动上报，没有的用 `wmux wrap` 做进程级状态。

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

## 侧栏 Agent 状态

左侧工作区行会显示本会话代理状态（优先级从高到低）：

| 状态 | 含义 |
|------|------|
| **Needs you** | 等你确认权限 / 回答问题（blocked） |
| **Working** | 本轮任务或进程在跑（含 `wmux wrap`） |
| **Running** | 仅 shell 有前台命令（非 agent 声明） |
| **Idle** | 空闲 |

数据来自 **声明式协议**（`pane.report_agent`），不是猜终端输出。窗格内已注入 `WMUX_SURFACE_ID` / `WMUX_PIPE` 等环境变量，CLI 默认识别当前 surface。

### Claude Code（零配置）

启动 wmux 时会向 `~/.claude/settings.json` 写入 Hook（保留你的其它条目）：

- `PostToolUse` → Working  
- `Notification` → Needs you  
- `Stop` / `SubagentStop` → 回合结束 / 子代理结束  

在 wmux 窗格里直接跑 `claude` 即可，侧栏会随工具调用与等人提示更新。

### 没有 Hook 的 Agent：用 `wmux wrap`

Kimi、Codex 等若暂无自动注入，用包装启动即可（**进程级** busy/idle；无法感知 permission 对话框）：

```powershell
# 必须在 wmux 窗格内执行（依赖 WMUX_SURFACE_ID）
wmux wrap kimi
wmux wrap codex --full-auto "fix tests"
wmux wrap --label opencode -- opencode
```

成功时终端会提示 `wrap: tracking … → working`，侧栏应变为 **Working**；进程退出后清除声明态。

| 现象 | 处理 |
|------|------|
| `wrap: no surface id` | 不在 wmux 窗格内，或 shell 未注入环境变量 |
| `could not report agent state` | 当前运行的不是含 agent-state 的构建，重启/重装后再试 |
| 侧栏仍显示 Running | 确认已重启新构建；Working 与 shell Running 不同，应用最新侧栏逻辑 |

### 任意 Agent 手动上报

Harness 或自写脚本可直接调用（surface 默认当前窗格）：

```powershell
wmux report-agent --run-start          # 或 --run-depth 1
wmux report-agent --blocked "permission: Bash"
wmux report-agent --unblocked
wmux report-agent --run-depth 0        # 回合结束
wmux release-agent                     # 取消跟踪
wmux agent-state                       # 查询全部 pane + blocked 列表
```

OpenCode 可通过已安装的插件推送活动；与 Claude 一样最终汇入同一侧栏状态机。更完整的 CLI 说明见仓库内 `CLAUDE.md`。

## 编译 Windows 可执行文件

从克隆仓库到产出 exe 的完整命令流程：

```bash
git clone https://github.com/amirlehmam/wmux.git
cd wmux
npm ci            # 1. 安装依赖
npm run build     # 2. 编译 + 打包，产出 exe
```

`npm run build` 内部依次执行三步（对应 `package.json` 中的 scripts）：

```bash
tsc -p tsconfig.node.json   # ① 编译主进程 / preload / CLI 的 TypeScript → dist/
vite build                  # ② 打包渲染进程（React 界面）→ dist/renderer/
electron-builder            # ③ 调用 electron-builder 打包为 Windows 安装包
```

如需分步调试，也可单独执行 `npm run build:main`（仅步骤①）或 `npm run build:renderer`（仅步骤②）。

产物输出到 `release/` 目录：

| 产物 | 说明 |
|------|------|
| `wmux-<版本号>-setup.exe` | NSIS 安装包（创建开始菜单和桌面快捷方式，可自定义安装目录） |

### 更多打包命令

已编译过 `dist/` 后，可直接调用 electron-builder 生成其他格式，无需重新完整构建：

```bash
npx electron-builder --win nsis       # NSIS 安装包（与 npm run build 的最终产物相同）
npx electron-builder --win portable   # 便携版单文件 exe，输出 release/wmux-<版本号>-portable.exe
npx electron-builder --win zip        # zip 压缩包，解压即用
npx electron-builder --dir            # 只生成未打包的目录（release/win-unpacked/），用于快速验证
```

> 注意：单独执行 `npx electron-builder ...` 前需先跑过 `npm run build:main` 和 `npm run build:renderer`（或一次完整的 `npm run build`），否则 `dist/` 不存在会打包失败。

打包配置（目标格式、图标、随包资源等）见 `electron-builder.json`。

## 其他常用命令

```bash
npm test            # 运行 Vitest 测试套件
npm run typecheck   # 检查渲染进程与主进程的 TypeScript 类型
npm run lint        # 对 src/ 目录执行 ESLint
```

## 许可证

wmux 基于 [MIT 许可证](LICENSE) 开源。它是受 [cmux](https://github.com/manaflow-ai/cmux) 启发的独立重写实现，未使用 cmux 的源代码。
