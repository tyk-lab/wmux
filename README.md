# wmux

Windows 下的终端复用器（Electron + Vite + React + xterm.js）。

## 环境要求

- Windows 10/11
- Node.js 18+（建议 LTS）
- npm

## 快速启动（开发模式）

```bash
git clone https://github.com/amirlehmam/wmux.git
cd wmux
npm install
npm run dev
```

- `npm install` 会自动执行 `postinstall`（`electron-builder install-app-deps`），编译 node-pty 等原生依赖。
- `npm run dev` 会启动 Vite 开发服务器（端口 `5199`），随后自动拉起 Electron 窗口；修改代码后界面热更新。

## 构建 Windows 安装包

```bash
npm run build
```

该命令依次执行：

1. `tsc -p tsconfig.node.json` — 编译主进程 / preload / CLI 的 TypeScript
2. `vite build` — 构建渲染进程
3. `electron-builder` — 打包 Windows 产物

安装包位于：

```
release/pswmux Setup 0.8.3.exe
```

同时会生成可直接运行的解包目录：

```
release/win-unpacked/pswmux.exe
```

安装包支持自定义安装目录，并创建桌面和开始菜单快捷方式。

**注意事项：**

- 如果直接运行解包版本，必须整目录使用：`pswmux.exe` 依赖同目录下的 `ffmpeg.dll` 等文件，单独拷出 exe 会报"找不到 ffmpeg.dll"。
- 打包前请关闭正在运行的 wmux：运行中的程序会锁定 `release/win-unpacked/resources/app.asar`，导致打包失败。
- 若 VS Code 打开了本项目文件夹，也可能占用 `app.asar`；如遇占用错误，可关闭对应 VS Code 窗口，或临时改输出目录：

```bash
npx electron-builder --config.directories.output=release/win-unpacked-new
```

## 其他常用命令

| 命令 | 说明 |
|------|------|
| `npm run build:main` | 仅编译主进程 / preload / CLI |
| `npm run build:renderer` | 仅构建渲染进程 |
| `npm test` | 运行 Vitest 单元测试 |
| `npm run test:watch` | Vitest watch 模式 |
| `npm run lint` | ESLint 检查 `src/` |

## 目录结构

```
src/
  main/               # Electron 主进程
  renderer/           # React 界面
  preload/            # contextBridge API
  cli/                # wmux CLI
  shared/             # 共享类型
  shell-integration/  # Shell 集成脚本
resources/            # 打包静态资源（主题、音效、插件等）
tests/unit/           # 单元测试
```

## 许可证

[MIT](LICENSE)
