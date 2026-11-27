# 开发与发布

[返回首页](../README.md) · [贡献指南](../CONTRIBUTING.md) · [架构说明](../ARCHITECTURE.md)

本文面向从源码运行、调试或打包 PiDeck V2 的开发者。日常使用和安装入口见[首页](../README.md#下载)，远程连接见[手机与 Web](REMOTE.md)。

## 环境准备

- 使用 [go.mod](../go.mod) 声明的 Go 工具链；当前为 Go 1.27.3，NSGo 固定为 `v0.3.4`。
- 使用 pi 后端时，运行目标上的 `PATH` 需要能找到 `pi`。应用以 `pi --mode rpc` 启动后端，会话放在应用自己的目录。
- ACP 使用对应外部 CLI；基于 `npx` 的预设需要 Node.js 和首次下载依赖的网络。DSH 使用外部 `dsh --profile acp`（npm 包 `@deepseek-ai/dsh`），不内嵌 host。
- Android、iOS 与桌面原生依赖可先用 `go tool nsgo doctor` 检查。iOS 开发需要 macOS 与 Xcode。

## 桌面开发

```sh
go run ./scripts                         # 交互入口
go run ./scripts dev                     # 热重载开发
go run ./scripts build windows_x64       # 构建一个目标
```

同一应用 ID 只运行一个桌面实例；重复启动会将已有窗口带到前台。开发版和已安装包需要同时运行时，为开发版指定独立实例：

```sh
PIDECK_V2_INSTANCE=dev go tool nsgo dev
```

PowerShell 对应先设置 `$env:PIDECK_V2_INSTANCE = "dev"`，再运行 `go tool nsgo dev`。开发过程也可用 `PIDECK_V2_HOME` 指向独立数据目录。

真实界面自动化使用 `go tool nsgo dev -automation` 配合 `go tool nsgo mcp`，启动方式、数据边界与内置工具见[贡献指南](../CONTRIBUTING.md#driving-the-real-app-optional)。

## Android 与 iOS

Android / iOS 目标显示远程客户端连接页，后端仍运行在电脑上。

```sh
go tool nsgo doctor
go tool nsgo dev -target android
go tool nsgo dev -target ios_simulator
go tool nsgo build -target android_arm64
go tool nsgo build -target android_x64
```

`android_arm64` 用于真机，`android_x64` 用于 x86_64 模拟器，后者需要 NDK。可用 `PIDECK_V2_MOBILE=1 go tool nsgo dev` 在桌面窗口预览手机界面；PowerShell 先设置同名环境变量再运行命令。

### Windows Android 模拟器

首次安装命令行工具与创建模拟器：

```powershell
winget install Google.AndroidCLI Google.PlatformTools
android emulator create medium_phone
android emulator start medium_phone
```

模拟器会下载系统镜像；NDK 与 SDK 是否就绪以 `go tool nsgo doctor` 的检查结果为准。仓库脚本可启动模拟器、构建并安装客户端：

```sh
go run ./scripts android up
go run ./scripts android app
go run ./scripts android link
go run ./scripts android status
```

连接前先在桌面端「设置 → 远程」启用服务。模拟器用 `10.0.2.2` 访问宿主机，端口以设置页为准；`android link` 复制带令牌的链接，粘贴到模拟器连接页即可。`android status` 显示 SDK、设备、AVD 与桌面连接状态。

## Web 构建与嵌入

WebAssembly 使用与手机相同的客户端界面。pi、文件、Git 和进程都由桌面端提供，桌面能力不进入 Web 产物。

```sh
go run ./scripts dev web                 # Web 热重载预览
go run ./scripts web                     # 构建并压缩 Web，再构建带页面的桌面程序
go run ./scripts build windows_x64       # 已有 site 时自动带嵌入标签
```

- `webassets/site/` 是生成目录，不手改、不提交；`scripts build`、`scripts pack` 在目录存在时自动加 `webassets` 标签。
- 首次没有站点资源时先运行 `go run ./scripts web`。直接构建只生成桌面程序，不保证包含可访问的 Web 页面。
- 页面从桌面远程端口提供，常见形式为 `http://<电脑地址>:<端口>/?token=<访问令牌>`；连接成功后从地址栏移除令牌查询参数。
- 自行托管可使用发布中的 Web 压缩包。浏览器仍需能访问桌面服务；跨网络连接和反向代理见[自托管说明](remote-self-host.md)。
- CI 对 brotli 压缩后的 Web 产物执行 **12 MB** 预算门禁。桌面依赖与客户端的边界见[架构说明](../ARCHITECTURE.md)。

## 验证

按修改范围选择检查和测试，具体分级见[工程规范](../AGENTS.md#33-验证分级只跑能证明本次改动的那一档)与[贡献指南](../CONTRIBUTING.md#workflow)。例如，单包逻辑使用指定测试：

```sh
go test ./internal/<包名> -run <测试名> -count=1
```

工作台 UI 按需使用 `go tool nsgo test -- -run <测试名> -count=1`；结构和跨包变更按贡献指南补充检查。文档改动核对事实、链接与 `git diff --check`，无需触发应用构建。

同一工作区内的 NSGo build / check / test 必须串行：Windows 构建会临时写入并删除模块根的 `.syso`，并发执行会互相干扰。只构建本次涉及的目标；不要为局部改动运行全仓库或全平台构建。

## 打包与发布

### 本地打包

```sh
go tool nsgo build -target windows_x64 -version <版本>
go run ./scripts pack
```

产物位于 `dist/`。`pack` 构建当前平台并生成 `<slug>-<版本>-<目标>-portable.zip` 及 `.sha256`；Windows 安装程序位于 `dist/releases/*-setup.exe`，需要 NSIS。未装 NSIS 时会保留 `.nsi` 并给出后续编译命令。

本地构建是否嵌入 Web 取决于 `webassets/site/` 是否存在；完整桌面安装包需要先生成这些资源。正式分发由 CI 统一构建。

### 发布工作流

[`release.yml`](../.github/workflows/release.yml) 由 `nsgo-v*` 标签触发；稳定标签形式为 `nsgo-v<版本>`，Dev 标签形式为 `nsgo-v<版本>-dev.<序号>`。标签推送会创建 Release；手动工作流也支持只构建、不发布。

| 平台 | 产物 |
| --- | --- |
| Windows x64 / arm64 | NSIS 安装程序 |
| macOS x64 / arm64 | DMG |
| Linux x64 / arm64 | DEB、Arch 包、AppImage |
| Android arm64 | APK 与 Android appcast |
| iOS | 真机 IPA、模拟器 `.app` 压缩包 |
| Web | 可单独部署的 Web 压缩包；桌面安装包同时嵌入页面 |

Release 的 `SHA256SUMS` 覆盖发布产物。更新签名使用仓库 Secret `NSGO_UPDATES_KEY`；移动端签名凭据可选：

| Secret | 未配置时的行为 |
| --- | --- |
| `ANDROID_KEYSTORE_B64`、`NSGO_KEYSTORE_PASSWORD`、`NSGO_KEY_PASSWORD` | 使用 NSGo 调试密钥；正式签名与调试签名的包不能直接覆盖升级 |
| `IOS_PROFILE_B64`、`IOS_CERT_P12_B64`、`IOS_CERT_PASSWORD`、`IOS_KEYCHAIN_PASSWORD`、`IOS_TEAM` | 生成未签名 IPA，需要自行重签；模拟器产物不受影响 |

### 通道与自动更新

- 稳定版读取 `releases/download/nsgo-stable/appcast-<目标>.xml`，Dev 版读取 `nsgo-dev` 通道；两者使用独立的应用标识与数据目录。
- V2 的 Release 使用 `make_latest: false`，共享仓库的全局 Latest 留给 Electron。下载入口应明确指向 V2 通道。
- 更新公钥位于 `nsgo.yaml` 的 `updates.key`（另存 `updates.pub`）；私钥 `updates.key` 不入库。维护者可用 `go tool nsgo keygen updates` 生成密钥。
- macOS / Windows 由 Sparkle / WinSparkle 安装更新，Linux / Android 由应用下载并验证签名后交给系统安装器。应用入口是「设置 → 关于 → 检查更新」或同名命令。
- 本地没有更新私钥时，不生成 macOS / Windows appcast；开发构建不检查更新。发布工作流会核对各目标的 appcast，避免更新地址缺失。
- Web 通过刷新页面更新；桌面版本与页面版本不一致时，会提示刷新。

### 其他自动化

| 文件 | 职责 |
| --- | --- |
| [`ci.yml`](../.github/workflows/ci.yml) | `nsgo` push / PR 的桌面测试、交叉构建、移动端与 Web 预算检查 |
| [`sync-atomgit.yml`](../.github/workflows/sync-atomgit.yml) | 将 V2 的 `nsgo` 同步到 AtomGit `ayuayue/PiDeck-V2` 的 `main`；同步 V2 稳定标签、发布正文与附件 |
| [`deploy-relay.yml`](../.github/workflows/deploy-relay.yml) | 手动部署 Cloudflare 中继，配置方法见[中继说明](../infra/relay-worker/README.md) |
| [`.github/dependabot.yml`](../.github/dependabot.yml) | 依赖更新检查；非默认分支需在默认分支设置 `target-branch: nsgo` |

AtomGit 同步使用 `ATOMGIT_TOKEN`，发布完成后由工作流显式触发；同版本重新构建可使用 `force_resync`。工作流入口与实际附件清单以仓库配置为准。
