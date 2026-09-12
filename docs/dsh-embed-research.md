# DeepSeek Harness 怎么嵌进 PiDeck

对照官方 0.1.5 架构文档、SDK / ACP / Desktop 嵌入口，以及仓库里已有的接入复核。

- 基线：PiDeck 锁 `@deepseek-ai/dsh` **0.1.5-rc.1**
- 上游：已到 **0.1.5-rc.2**（2026-09-10）
- 配套：`docs/dsh-backend-integration-review.md`、`docs/dsh-native-plugin-parity-plan.md`

**结论速览**

| 传输选型 | 组合 / profile | Client 半区 |
|---|---|---|
| 对 | 偏 | 缺 |

---

## 你的直觉是对的，但不是传输做错了

传输层（utilityProcess + fetch 桥）现在仍然是官方给 Electron 的形态。走偏的是组合层：PiDeck 在用 rc.6 时代的 `boot()` + 自组补丁树，而 0.1.5 已经把「每个 Node 应用都必须从 named profile 启动」写成硬规则。

DSH 的特性（插件、预设、轨迹、Client 半区）活在那棵插件树上，不活在 PiDeck 的 React 视图里。

---

## 官方给外界的适配面

他们没有「把 DSH 当库 import 进别人的 React」这条路。对外的稳定面是 profile、协议和载体，不是内部 `boot()`。

| 嵌入口 | 官方定位 | 对 PiDeck | 能拿到什么 | 硬限制 |
|---|---|---|---|---|
| **Profile + Connection RPC** | 官方桌面/Web 同一套 Host | **应走这条** | 完整 84 端点、审批、插件、会话、设置 | 必须用 profile，不能自组 cordis 树 |
| **Official Desktop** | 第一方 Electron 产品 | 不要做成 PiDeck | Client 图 + `dsh-app://` + 官方 UI | 会吞掉 pi 后端和 PiDeck chrome |
| **SDK JSON-RPC** | 程序驱动 / CI / 子代理 | 否决（桌面会话） | `initialize` / `prompt` / `shutdown` | 无 abort、无列表、无设置、无审批应答 |
| **ACP stdio** | IDE 自动化 | 否决 | Agent Client Protocol | 权限自动应答，能力面更薄 |
| **Wrap `dsh web`** | 社区桌面壳主流 | 否决 | 100% 官方 UI | 端口、进程、无法服务 pi 会话 |

### 明确在做、给外部用的

- **Profile + bundle。** 自定义组合 = 一个 profile 目录 + 有序 patch，不是另一份可执行文件，也不是内联 cordis 树。Python / TS SDK 都改成选 profile，旧的直连 config carrier 已删除且无兼容入口。
- **Typert Remote / Connection RPC。** 挂载即注册。0.1.5 给宿主的正式扩展点是 `ClientTransportHooks`（`fetch` + `openStream`）。PiDeck 的 MessagePort 桥正好落在这里。
- **SDK / ACP。** 程序驱动和 IDE 自动化的薄协议。文档原话：这就是「把 DSH 当嵌入 runtime」——给 CI 和编排器用，不是给完整会话 UI 用。
- **插件生态。** `dsh plugin --profile` 走 pnpm；标准化扩展点、Agent Teams（实验、默认关）、子代理可续聊。Client 插件走 `dsh.client` + Slots，不是 Host RPC。

### 第一方 Desktop，不是给你们当库

架构页新增「Desktop application」专节：保留 `$DSH_HOME/profiles/desktop`；签名包绑定一个确切 dsh 版本 + 离线 seed；内置 pnpm 装进可写 profile。

Electron 拉起私有 Desktop Host（捆绑一份上游 Node，不是 `ELECTRON_RUN_AS_NODE`）。Unary RPC、Remote stream、版本匹配的 client 资源走分帧字节管道；Node IPC 只做生命周期；渲染层走 `dsh-app://`。不开 Web server、不占端口。

CLI 与 Desktop 共享 `$DSH_HOME` 里的产品数据，但绝不共享可执行包、插件激活、lockfile、`node_modules`。这和 PiDeck「默认 `~/.dsh` 但 profiles 必须私有」的判断一致。

仓库里已有 `@deepseek-ai/dsh-desktop`、`dsh-host-desktop-carrier`；社区讨论 #4628 证实 desktop carrier 是公开扩展面，但第三方 `webServer` 路由在桌面壳上仍有 body/Host 缺口。它服务的是官方前端图，不是 PiDeck 渲染层。

---

## 0.1.5 他们自己在规划什么

`v0.1.5-rc.1`（2026-09-10）是自 0.1.2 以来的大版本；`rc.2` 只修反馈 / 文件卡片。对嵌入方真正有影响的是协议和插件 API，不是 Flash 模型。

| 变化 | 对嵌入方的含义 |
|---|---|
| Session 日志升到 V3；persistence 改为 `SessionHandle`；同 session 最多一个进程持有 | 自建扫描/投影必须跟迁移链；多进程同时打开同一 DSH 会话会锁冲突 |
| 插件 API：移除 `ctx.agent`，必须显式传 Agent；Inbox 不再可构造 | PiDeck 自写的 slash / minimal-filter 等 host 插件要按新 API 改，不能继续摸内部对象 |
| Web 插件面板：`sidebar.panellist` + `main`；`conversation` Slot 迁到 `main.conversation` | Client 半区贡献点在变。PiDeck 静态 React 永远接不住，除非托管官方 client 图 |
| 文件上传、Sidebar 预览、message feedback、Open in app、Agent Teams | 这些都是 host/client 行，不是 PiDeck 该重写的 UI。没挂行 = 没特性 |
| SDK 明确：选 profile + patches，禁止完整外部 `cordis.yml` | 印证「自组组合」是过期做法。官方连 SDK 都不让调用方塞一棵树 |
| `verify-application-entrypoints`：绕过 dsh CLI 的 Node 应用路径会被拒绝 | 他们在收紧启动面。`boot()` 还在，但不再是对外承诺的应用入口 |

---

## 现状对照：同一载体，不同地基

### 官方 Web / Desktop

`dsh` CLI → named profile → bundles + patch 层 → heal 两锚解析 → Host Connection RPC → Client 模块图（`__DSH_BOOT__`）→ Slots / Conversation 渲染。

特性来自插件树。换皮肤不用重写 Agent。装 npm 插件是 profile 的事。

### PiDeck 现在

`hostEntry` 自组 dsh-base 补丁 + PiDeck insert 行 → `boot(bareModuleBaseUrl=runtime)` → MessagePort fetch 桥 → `DshRemoteClient` 手写 27 个端点 → `dshEventProjector` → 静态 React。

主链路能跑。树外插件解析不到。Client 插件、官方 UI 贡献点结构性缺失。两座自建桥在 0.1.5 已冗余。

### 「只有前端不一样」为什么会越做越不像 DSH

协议和 Agent 能力大约 90% 对齐。剩下 10% 不是视觉：官方前端内含客户端插件运行时。PiDeck 用静态 React 复刻视图，所以轨迹按来源检查、Creator 模式、插件面板、Sidebar 文件交付这些 DSH 特性，要么缺失，要么被做成 pi 风格的工具卡。越补 UI，越像在养第二套 harness。

---

## 该留、该改、不该抄

| 动作 | 对象 | 理由 |
|---|---|---|
| Keep | utilityProcess + MessagePort fetch 桥 | 官方 `ClientTransportHooks` / Electron IPC 载体的原话形态；官方 Desktop 也是无端口管道 |
| Keep | PiDeck chrome：多项目、pi+dsh 并列、Git/终端/文件抽屉 | 这是产品差异，不是 DSH 该做的事 |
| Keep | 共享 `$DSH_HOME` 的配置/凭据/会话/预设 | 官方 Desktop 也共享产品数据；可执行包与 `node_modules` 必须隔离 |
| Change | 自组 patch 列表 + `bareModuleBaseUrl` 单锚点 | 0.1.5 起官方唯一启动单元是 named profile；直连 `boot` + 内联树已被标成非 launcher |
| Drop | `pideck-plugin-bridge` / `pideck-command-bridge` / 长期 slash 桥 | Typert 已挂 `commands/*` 与 `pluginInventory` / `dynamicCordisRunner`；自建桥是升级税 |
| Don't copy | 官方 Client 运行时 / `dsh-app://` / 官方 Desktop Host 包 | 那是第一方产品，不是给 PiDeck 当库用的；会失去双后端 |

---

## 更好的嵌入原则

**Host 是 DSH，Chrome 是 PiDeck。**

PiDeck 只做窗口、多项目、pi/dsh 路由、Git/终端。DSH 会话里的 Agent 行为、工具、插件、预设、轨迹、审批、技能，全部交给 DSH 插件树和官方 Remote。不要把 DSH 捏成「另一个 pi」。

### 做：让 DSH 像 DSH

- profile 化，用户能装官方/社区 bundle
- preset（standard / code / minimal / creator）走 host
- 轨迹、goals、subagents、skills 读 host 投影
- 命令和插件走官方端点，不自建桥
- 与 dsh CLI 共享 settings / credentials / sessions

### 不做：不要变成官方壳

- 不内嵌 `dsh-web-frontend` / client runtime 去服务 pi
- 不迁 SDK / ACP 薄协议（功能倒退）
- 不 spawn `dsh web` 占端口
- 不共用官方 `profiles/desktop`（版本打架）
- 不把 PiDeck 功能做成 DSH 插件再反嵌自己

---

## 建议落地顺序

`docs/dsh-native-plugin-parity-plan.md` 和 `docs/dsh-backend-integration-review.md` 已经写对了方向，缺的是执行优先级：先停写第二套 harness，再减桥，再换地基。

| 阶段 | 周期 | 做什么 |
|---|---|---|
| **0 停损** | 立刻 | DSH 特性不再用 pi 语义重做一遍。缺的就声明缺失或挂官方行，不写第二套 goals / trajectory / 引用。 |
| **1 减法** | 1–2 周 | 删两座自建 RPC 桥，命令改走 `commands/list` + `commands/execute`。净减维护面，给 profile 化让路。 |
| **2 profile 化** | 架构级 | 迁到 `$DSH_HOME/.pideck/profiles/pideck-dsh`，走 `initProfile` + `healProfilesModuleFallback` + `patchReload:live`。这是 npm 插件能活的唯一正解。 |
| **3 补 DSH 特性行** | profile 之后 | 挂 `message-feedback`、`workspace-files`、`session-reference`、`session-log-download`。这些才是用户能感知的 DSH 味。 |
| **4 投影消费** | 持续 | 轨迹 / 轮次大纲 / 文件树尽量读 host projection，而不是 PiDeck 再投影一遍。升级时跟官方，不跟自己。 |

### Client 半区先不要立项

官方 Desktop 用匹配的 client 图解决插件 UI。PiDeck 若托管那套运行时，DSH 会话会完整，但无法服务 pi，等于在应用里嵌第二个产品。等 profile + host 行齐了，用户仍明确缺插件面板时，再评估「DSH 会话可切换到官方 Conversation 视图」——那是产品决策，不是现在的技术债。

---

来源：<https://deepseek-harness.github.io/deepseek-harness/en/reference/> · 0.1.5-rc.1 / rc.2 release notes
