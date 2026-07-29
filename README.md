<h1 align="center">wmux</h1>
<p align="center">Windows 上 Claude Code 的可视化层 —— 实时查看 AI 代理的一举一动</p>

<p align="center">
  <a href="https://github.com/amirlehmam/wmux"><img src="https://img.shields.io/badge/platform-Windows-0078D4?logo=windows" alt="Windows" /></a>
  <a href="https://github.com/amirlehmam/wmux/releases"><img src="https://img.shields.io/github/v/release/amirlehmam/wmux?label=release&color=555" alt="Release" /></a>
  <a href="https://github.com/amirlehmam/wmux/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-555" alt="License" /></a>
</p>

wmux 是基于 Electron + xterm.js 的 Windows 终端复用器，专为 AI 代理设计：支持分屏窗格、实时浏览器面板、Claude Code 会话的侧边栏状态指示，以及可编程的命名管道 API。

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
