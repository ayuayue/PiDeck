# 手机 / Web 斜线命令与子代理

在手机端打开 pi 会话，在聊天输入框中发送：

```text
/compact
```

也可以附带本次压缩需要保留的内容：

```text
/compact 保留任务目标、已修改的文件与验证结论
```

电脑端会调用 pi 的上下文压缩指令，不会把这条命令创建成普通提问。压缩时请勿附带图片；会话正在运行、启动、加载历史、重试或压缩时会拒绝本次发送，手机端会显示错误并保留草稿。

## 命令候选与执行

手机和 Web 使用同一个客户端。在已打开的 pi 会话输入 `/`，可以查看、筛选并选择该会话已加载的扩展命令、提示词模板和 `/skill:名称`；`/compact` 由宿主补入。候选按需查询，失败可重试，列表分批展开。选择只填入输入框，按发送后才执行；发送失败会保留草稿。运行 `/reload` 后，下次输入命令前缀会重新查询候选。

扩展命令、技能和模板通过 pi 的 `prompt` 通道执行，运行中也不会误发到不接受扩展命令的 `steer` / `follow_up` RPC。普通消息仍采用原有投递方式。斜线命令在生图模式下也作为命令发送。pi TUI 专属且没有 RPC 的命令不在支持范围内。

ACP 命令原文交给对应 agent，是否支持由该 agent 决定；运行中排队到本轮结束后发送。当前不为 ACP 会话查询 pi 命令候选。

## 子代理与父子会话

输入框上方显示子会话、子代理或工作流的运行状态；“查看全部”打开分批加载的任务列表。后台派发成功不等于执行完成，完成、失败或取消通知会更新对应任务的结束状态。点击子会话可进入，子会话中的父会话按钮可返回；点击工具任务会定位其来源轮次，必要时加载更早的历史。

会话栏按父子关系缩进，最近活跃的子会话会与父会话一起保留在最近列表中。父会话缺失或关系形成循环时，相关会话仍作为顶层条目可见。只有工具输出、没有可识别会话关系的任务，保留任务状态与来源定位，不会生成虚假的子会话链接。

## 远程接口与兼容

新增已鉴权的 `GET /api/session/{id}/commands`，返回 `commands` 数组，每项只含 `name`、可选 `description` 和 `source`，不转发运行时的 `sourceInfo` 本地路径。

现有状态接口的会话项新增可选 `parentID`；会话历史响应新增可选 `activity`，包含 `parent`、`children` 和 `delegations`。会话链接只使用 ID、标题和状态；任务项包含 ID、名称、状态和来源轮次 `turn`。缺少这些字段的旧桌面仍可提供原有平面会话和聊天功能；旧客户端会忽略新增字段。

## 回归验证

```sh
go test ./internal/workbench -run '^(TestRemoteCompactCommand|TestRemoteCompactCommandRefusals|TestRemoteOtherSlashCommandsReachPi|TestRemoteBusyCommandDelivery|TestRemoteCommandDiscovery|TestRemoteSlashCommandFailureAndTrust|TestRemoteSessionActivityLinksAndTaskCompletion)$' -count=1 -timeout=90s
go test ./internal/client -run '^(TestMobileSlashCommandSendAndRecover|TestMobileCommandCandidatesAndRetry|TestMobileSubagentNavigation|TestMobileSessionTreeKeepsFamiliesAndOrphansVisible)$' -count=1 -timeout=90s
```

测试使用模拟桌面、真实客户端界面和模拟 pi 传输，覆盖命令发现与路径过滤、候选选择与重试、失败草稿恢复、HTTP 命令分发、压缩附加要求、信任校验、ACP 排队、后台任务结束状态、父子会话导航，以及孤立和循环关系。测试不依赖真实账号或设备；实机与真实扩展交互验收需另行进行。
