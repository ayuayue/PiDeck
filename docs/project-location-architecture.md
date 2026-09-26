# ADR: 以项目为根的本机、WSL、SSH 位置模型

> 状态：Proposed（产品方向已讨论；数据结构、迁移与阶段排期仍待评审）。仅记录决策建议，不表示已经实现。
>
> 适用工作树：`feat/remote-development`。此文不改变 SSH 远程开发实施计划的 Phase 2-5 安全和发布门禁。

## 背景与问题

用户应能在同一项目列表中同时打开本机、WSL 和 SSH 项目。现在 Windows 上的“Pi 来源：Windows/WSL”是全局设置：`DevTab` 写入 `wslEnabled`，`projectsIpc` 用它过滤项目列表、决定新增项目的位置，并用全局 `wslDistro` 转换已有 WSL 项目路径；`TerminalSessionManager` 用它选择 WSL shell。切换一个设置会改变所有项目的可见性和部分执行上下文。这不是三个并列位置。

Phase 1 已有 `ProjectLocator = local(environment: native | wsl) | ssh`、项目相对文件目标和本地 backend 的边界，但目前 `ProjectStore` 的业务对象仍是旧 `path/environment` 形状，v2 codec 拒绝读取 SSH 项目；会话 catalog 仍有旧环境字段与全局 WSL 身份上下文。这些是兼容过渡，不应被当作“WSL/SSH 项目已可并存”的完成证据。[实施计划](remote-development-plan.md) §5.1、§11.2 和 §12 的范围、协议与阶段门禁继续有效；具体的旧数据判定、现有 WSL 执行链路和测试缺口见 [WSL 位置迁移基线](wsl-location-baseline.md)。本 ADR 专门补充位置的产品语义和迁移门禁。

## 建议决策

1. **项目是入口和持久身份**：项目 ID 保持稳定；每个项目绑定一个判别明确的位置与根目录。主界面同时列出所有已注册项目；按位置筛选只是显示偏好，不改变项目身份或运行位置。会话继承所属项目的位置，并保留自己的稳定 `SessionRecord.id`。
2. **三个并列的用户选项**：“本机目录”、“WSL 发行版中的目录”、“SSH 主机上的目录”。位置由添加项目时明确选择，而不是从全局 `wslEnabled`、当前标签页、路径形状或默认 shell 推断。WSL 仅在 Windows 提供，已有项目在 WSL 不可用时仍保留离线条目。
3. **内部可共享实现，不共享身份**：本机和 WSL 可继续使用 Windows 主进程的部分文件访问和现有 Pi/PTY 适配；但它们必须有不同的 location key，所有能力必须按项目位置选择执行环境。SSH 保持独立的、经认证的主机端点，不将远端路径交给本地 fs/Git/shell。
4. **配置不是当前模式**：SSH 主机 profile 与 WSL 发行版/用户配置属于可复用连接资料；Pi 可执行文件、认证、模型与代理按执行目标解析；主题等 UI 设置仍属本机。全局 WSL 设置在过渡期只提供旧数据迁移提示或新增项目表单默认值，绝不作为现有项目和会话的路由依据。
5. **单一位置真相**：规范化的 Project/Session 只以 locator/ref 确定位置。`path`、UNC、`environment`、`wsl*` 等旧字段仅允许在明确的 local compatibility adapter/reader 中出现；display path、终端标题和最近使用路径不可反向成为授权依据。

建议的目标语义（不是当前 TypeScript 契约，也不是要求立即改写 Phase 1 v2 文件）：

```ts
type ProjectLocator =
  | { kind: "native"; path: string }
  | { kind: "wsl"; distro: string; user: string; linuxPath: string }
  | { kind: "ssh"; hostId: string; remotePath: string };
```

实施时可保持既有 `local + environment: wsl` 内部编码，只要对外等价于独立 WSL 分支、强制携带发行版与执行用户、拒绝缺失信息时回落到本机。`user` 是 Pi/终端/会话的执行主体，不应作为“全局最后一次选中的用户”。WSL `/mnt/c/...` 与本机 `C:\...` 即使对应同一磁盘目录，也可分别注册项目，因为 Pi 配置、命令、会话和授权的作用域不同；产品上应明示它们可能指向同一工作树，避免用户误以为是两份代码。WSL Linux 文件系统中的项目以发行版和绝对 Linux 路径标识；UNC 只是 Windows 侧访问投影，不是项目的持久身份。

项目去重和信任键至少包含 `(location kind, endpoint/distro, execution principal, canonical root)`；对 SSH 还须沿用实施计划 §5.2/§8 定义的端点身份、已验证 host key 与 trust 规则，不得因相同路径共享授权。WSL 发行版改名、用户变化、SSH host rebind 都是显式迁移，不静默改写已有项目的归属。

## 能力与归属对照

此表区分**目标路由**与**当前状态**。SSH 的“目标”不表示已实现；更完整的远端 v1 支持/禁用清单见[实施计划](remote-development-plan.md) §13。

| 能力 | 本机项目 | WSL 项目 | SSH 项目目标 | 迁移关键点 |
| --- | --- | --- | --- | --- |
| 项目列表、添加、离线态 | 本机目录 | 选发行版、用户及 Linux 目录 | 选已验证主机及受限远端目录 | 同屏显示；不再用全局开关过滤；不可达不自动删除 |
| 文件树、读写、搜索 | 本机 project-relative target | 按项目 distro 访问/转换，边界校验 | 远端 helper，严格 project-relative | 展示路径不作授权；未支持或不可达时明确报错 |
| Git、worktree | 本机 Git | 现有基线为 Windows Git；迁移后按项目固定执行位置 | helper 上的远端 Git；v1 worktree 禁用 | 不把位置模型变更偷换成 WSL Git 迁移；若要更改另行评审 `/mnt`/UNC 的兼容性 |
| Pi runtime、模型、认证 | 本机 Pi 及凭据 | 指定发行版和用户的 Pi、HOME 及凭据 | 远端 Pi、配置及凭据 | 一个项目的 Pi 来源不受切换其他项目影响 |
| 终端 | 本机 shell，项目 cwd | `wsl.exe -d/-u --cd`，项目绑定值 | SSH PTY，远端项目 cwd | shell picker 可提供显式覆盖，但项目终端默认位置不可猜 |
| 会话创建、恢复、历史 | 本机会话文件 | 发行版/用户作用域的会话文件 | 远端会话 locator + 本地索引 | Session ID 稳定；扫描、origin 与路径别名不能跨目标碰撞 |
| 项目配置、skills、扩展 | 本机项目与 Pi home | WSL 项目与对应用户 HOME | 目标主机项目与用户 HOME | 设置页查看目标与当前会话运行目标分离；凭据不自动同步 |
| trust/security、资源 | 本机目录授权 | WSL 身份 + 规范路径授权 | 已验证 SSH 端点 + 规范路径授权 | 跨位置、用户或端点不继承授权 |

## 分批迁移与验收

此顺序是**在现有 Phase 1/后续 Phase 计划上的补充门禁**，不是宣布下一 Phase 开工；每批完成后本机和已有 WSL 功能仍须可用。

1. **定契约与旧数据清单**：核对 ProjectStore v1 数组/v2 envelope、SessionCatalog v1、全局 `wslEnabled/wslDistro/wslUser`、`/mnt/<drive>`、`\\wsl.localhost` 及旧 trust key 的实际记录。UNC 中的 distro 可以提取，但执行用户不能从 `/home/u` 推断；缺 distro 或 user 的项目只有存在可审计且唯一的逐项目绑定证据时才可自动认领，**当前全局设置及其默认值即使碰巧匹配也不算证据**。否则保留原 ID 和路径，提示用户明确确认。迁移预检与交互式认领应在并存模式启用前提供；此前旧单模式保留运行兼容，进入并存模式后未认领项目标为 `needs-attention`、禁止执行或回退本机，不得直接强制切换用户。字段 distro 与 UNC 冲突同样必须停下处理；旧 dismissed-path 和 trust 记录不能按纯路径直接转成新授权。升级须保留 primary/backup 可恢复，防止 catalog 无法读取时空表被写回；不丢项目 ID 和 Session ID。
2. **先完成按项目路由，再开放并列操作**：逐域落实 files → Git → terminal → Pi launcher → Session history/catalog → config/skills/extensions/trust。每个 IPC 从可信 `projectId`/`sessionId` 解析位置；旧 local adapter 只支持本机/已明确绑定的 WSL，SSH target 在支持前 fail closed。先检查 Git 与文件在 WSL `/mnt`、UNC 两种存储路径下的现有执行语义，再决定统一走哪种 adapter，不通过转换路径来暗中切换 Git 实现。尚未迁移的操作必须按项目禁用并说明原因，不可取当前全局 WSL 配置凑合执行。
3. **交付三位置并列的项目列表与添加入口**：列表从持久项目读，不受 Pi 来源开关过滤；“添加项目”显式选本机/WSL/SSH（SSH 入口到远端只读阶段前可标为尚不可用）；WSL 选择可填发行版/用户。UI 可以先展示已有项目和不可达状态，但本机/WSL 同时可操作的入口必须等第 2 批相关路由及第 4 批并存回归通过后才启用。连接失败仍保留已登记项目。旧设置保留读取/兼容，但不再充当项目路由开关。
4. **并存回归门禁**：Windows 上本机项目 A、Ubuntu 的 B、另一发行版的 C 同时可见；两条发行版内相同 `/home/u/repo` 互不复用文件、会话、终端和 trust；本机 `C:\repo` 与 WSL `/mnt/c/repo` 允许作为两个执行上下文；切换项目/标签页不重写 Pi 环境；发行版停止、改名或用户变更时只影响引用它的项目且不可回退本机。SSH 上线后补两个主机同路径、断线/重连、host-key 变更和远端禁用能力的隔离测试。非 Windows 平台保留本机/SSH，绝不展示可执行的 WSL 入口。
5. **阶段门禁不得提前放宽**：Phase 2 可先开发不联网的主机身份/连接契约及 Windows → Linux 受控路径；macOS/Linux 客户端各自在启用 SSH 连接前完成已认证 fingerprint 与环境变量验证，未验证平台不得激活 profile 或启动远端进程。稳定版仍须达到[实施计划](remote-development-plan.md) §14.2 的发布矩阵；Phase 3/4/5 的只读、Agent、写入与 Git/终端发布边界继续按原计划。未经跨目标并存回归，不得移除旧设置兼容读取，也不得宣称三位置功能已交付。

## 仍需评审的问题

- WSL 项目是否允许同一发行版/目录以两个执行用户注册为两个独立项目？此 ADR 建议允许并明确区分，避免会话与授权串用；需要产品确认 UI 呈现。
- 旧 `/mnt/...` 记录没有绑定 distro 时的交互式认领流程、是否存在比全局设置更可靠的历史来源，以及原有 dismissed-project 路径名单的迁移口径。
- WSL Git、文件写入、watch 和终端在 `/mnt` 与 Linux 文件系统目录上的现有行为差异；需要平台实测后选适配边界，不能因文档设计而改变用户已有工作流。
- 既有 `ProjectLocator` v2 已写入磁盘，若改成三分支须明确 v2 兼容解码/后续 schemaVersion，而不是静默改变 v2 的含义。

## 参考资料

- [VS Code Remote Development](https://code.visualstudio.com/docs/remote/remote-overview)、[Remote - SSH](https://code.visualstudio.com/docs/remote/ssh)、[Developing in WSL](https://code.visualstudio.com/docs/remote/wsl)：同一工作区体验下，本机/WSL/SSH 对应不同执行位置；VS Code 使用官方 Remote 扩展。
- [Zed Remote Development](https://zed.dev/docs/remote-development)：本地 UI 与远端执行环境分离，SSH 接入是产品能力。
- [Microsoft WSL 文件系统建议](https://learn.microsoft.com/en-us/windows/wsl/filesystems)：使用 Linux 工具开发时优先在 Linux 文件系统内存放项目。
- [Codex cloud environments](https://developers.openai.com/codex/cloud/environments)、[Codex Remote connections](https://learn.chatgpt.com/docs/remote-connections)：云任务/远程控制与“编辑任意自有 SSH 项目”不能直接等同，不能仅凭产品名决定 PiDeck 的传输或项目模型。

上述厂商链接为设计参考，不是 PiDeck 兼容性承诺；本次调研环境无法直接抓取官方页面全文，涉及厂商产品细节应在实现或发布文案前重新核验。
