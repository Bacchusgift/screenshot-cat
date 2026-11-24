<div align="center">
<img src="src-tauri/icons/128x128@2x.png" width="128" alt="截图猫像素猫图标" />

# 截图猫 · Screenshot Cat

轻巧的托盘截图、录屏与剪贴板工具。平时安静待命，需要时再呼出。

[项目主页](https://bacchusgift.github.io/screenshot-cat/) · [下载安装](https://github.com/Bacchusgift/screenshot-cat/releases/latest) · [MIT](LICENSE) · Rust + Tauri 2 · 内置裁剪版 FFmpeg
</div>

## 使用方式

启动后只有系统托盘 / macOS 菜单栏中的猫咪图标，不打开主窗口，macOS 不显示 Dock 图标。点击猫咪，所有操作都在菜单中：

- 区域截图、GIF 动图、MP4 视频录制、停止录制。
- 呼出文字 / 图片剪贴板、贴上最近图片、关闭全部贴图。
- 暂停剪贴板记录、主动打开本地截图与视频记录或偏好设置、退出。

**截图完成即复制**：框选、确认后自动保存 PNG 并放进系统剪贴板；桌面底部短暂显示缩略图，保持原应用焦点。需要标注时，在底部条目上选择画笔；支持画笔、箭头、矩形、撤销和导出。

**文字和图片剪贴板**：后台记录复制的内容，按 `⌘ Control V` 呼出底部横栏；筛选、搜索，点击条目或用左右方向键与 Enter 选择，恢复原应用并粘贴。点击“复制”则只写入剪贴板。按 Esc、点击关闭或切换到其他窗口收起。Windows / Linux 快捷键为 `Ctrl Alt V`。

复制图片会自动显示底部栏约 6 秒，复制文字安静记录；手动呼出的横栏不会自动消失。文字按完整内容去重，图片按像素与尺寸去重，重复复制会移到最前。默认最多保留 100 条、128 MiB，文字单条 1 MiB、图片最多 1600 万像素；超限自动清理最旧记录。记录和缩略图只保存在本机。macOS 密码管理器标记为 concealed/transient 的内容不会记录。

## 快捷键

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 区域截图 | ⌘ ⇧ 1 | Ctrl Shift 1 |
| 视频录制 | ⌘ ⇧ 2 | Ctrl Shift 2 |
| GIF 动图 | ⌘ ⇧ 3 | Ctrl Shift 3 |
| 停止录制 | ⌘ ⇧ X | Ctrl Shift X |
| 绘制 / 操作原窗口 | ⌘ ⇧ D | Ctrl Shift D |
| 剪贴板横栏 | **⌘ Control V** | **Ctrl Alt V** |

快捷键被其他软件占用时可在偏好设置查看。截取显示器默认跟随鼠标。录制期间的透明标注窗口仅覆盖选区；切换穿透可操作原来的界面。

## 权限与平台

macOS 截图 / 录屏需要“屏幕与系统音频录制”权限，**自动粘贴**需要“辅助功能”权限。未授权时，选择记录仍会复制到系统剪贴板，可回到目标窗口按 ⌘V；软件不会自行授予权限。屏幕权限入口在托盘菜单的偏好设置中，授权后退出并重新打开应用。

Windows 自动粘贴受前台窗口及管理员权限边界限制；不允许注入时改为手动 Ctrl+V。Linux 当前面向 X11；Wayland 尚未接入 PipeWire 录屏与自动粘贴，只可使用可用的剪贴板复制路径。Linux 不同桌面环境对托盘的支持不同。

MP4 支持 15 / 30 / 60 FPS，直接写盘，没有人为时长上限；GIF 最长 15 秒，以 12 FPS 生成调色板动图。macOS 优先 VideoToolbox，Windows 优先 Media Foundation，失败时回退到 MPEG-4 软件编码。只有实际收到首帧才进入录制状态，12 秒没有画面会退出并提示。**当前不录制声音**，不包含滚动长截图、OCR、云同步或自动更新。

## 开发

需要 Node.js 22.12+、pnpm 10、Rust 1.90，以及 [Tauri 平台开发依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
pnpm install
pnpm prepare:ffmpeg
pnpm dev
```

`pnpm dev` 同样只启动托盘。需要界面时从托盘菜单打开。网页预览：`pnpm dev:web`；直接访问 `/?view=clipboard` 预览底部横栏，默认路径为可选管理面板。网页不具备全局监听、桌面贴图和窗口间自动粘贴权限。

检查与打包：

```sh
pnpm typecheck
pnpm test
pnpm test:rust
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
pnpm bundle
```

前端测试自动启动预览服务，本机默认使用 Chrome，CI 使用 Playwright Chromium。测试不会读取本机真实剪贴板。原生剪贴板测试使用独立临时目录，覆盖去重、持久化、超限和路径校验。

### 内置 FFmpeg

默认从官方源码构建 FFmpeg 8.0 的 LGPL 裁剪版，不启用 GPL/nonfree、x264/x265、网络、音频和播放器。安装后的用户无需另外安装 FFmpeg、Rust 或 Node.js。

macOS / Linux：`pnpm prepare:ffmpeg`。Linux 需 pkg-config、XCB 开发依赖。Windows：在 MSYS2 MINGW64 中运行 `sh scripts/build-ffmpeg.sh`，再将 `FFMPEG_PATH` 指向 `artifacts/ffmpeg-build/ffmpeg.exe` 执行 `pnpm prepare:ffmpeg`。macOS 的准备脚本会检查外部 dylib，所有平台会验证必需的屏幕采集模块。

原始源码、完整许可与重建说明随发布包提供。自选 `FFMPEG_PATH` 二进制需要提供其自身对应的源码和许可，不能沿用默认构建的说明。

## 自动构建

[GitHub Actions](.github/workflows/build.yml) 对默认分支、`feat/**` 分支、PR 和手动触发执行：

- 前端类型检查、剪贴板界面与交互测试。
- Windows x64：源码构建内置 FFmpeg，运行 Rust 测试与 lint，生成 NSIS `.exe` 安装程序。
- macOS Apple Silicon / Intel：原生构建内置 FFmpeg，运行 Rust 测试与 lint，生成 `.app` ZIP 和 `.dmg`。
- 所有产物可在 Actions 的 Artifacts 下载。推送 `v*` 标签后，待所有平台成功，再自动创建 GitHub Release 并上传安装包、FFmpeg 源码及许可。

当前不配置付费代码签名证书或 Apple 公证；macOS 构建使用 ad-hoc 签名。正式对外分发可在此基础上接入开发者证书。普通构建仅需要 GitHub 自动提供的 token，标签发布仅在 release job 中开启 contents:write。

## 结构与本地数据

Rust 原生模块负责托盘、截取、录制进程、剪贴板变更检测、原窗口焦点恢复；没有隐藏的工作台渲染器参与核心流程。macOS / Windows 用系统剪贴板变更计数器，仅变化后读取文字 / 解码图片。前端原生 TypeScript，横栏、工具窗口与可选面板按需加载。

- `src-tauri/src/clipboard.rs`：本地剪贴板历史、限额与监听、底部窗口。
- `src-tauri/src/focus.rs`：恢复已验证的目标窗口并发出粘贴操作。
- `src-tauri/src/shell.rs`：托盘菜单和可选面板。
- `src-tauri/src/capture.rs` / `recording.rs`：截图 / 录屏。
- `src/clipboard.ts`：底部横栏；`src/app.ts`：仅主动打开的辅助面板。
- `src-tauri/icons/app-cat.png`：AI 生成的像素猫主图；托盘使用独立单色像素猫。

为保留早期本地记录，应用标识仍为 `com.captureking.desktop`。数据在系统应用数据目录的 `captures/` 与 `clipboard/` 中，全部不纳入仓库。

## 许可

应用代码与图标采用 [MIT](LICENSE)。FFmpeg 及其他依赖遵循各自许可，详见 [第三方许可](THIRD_PARTY_NOTICES.md)。
