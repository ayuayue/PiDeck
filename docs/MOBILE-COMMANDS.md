# 手机端斜线命令

在手机端打开 pi 会话，在聊天输入框中发送：

```text
/compact
```

也可以附带本次压缩需要保留的内容：

```text
/compact 保留任务目标、已修改的文件与验证结论
```

电脑端会调用 pi 的上下文压缩指令，不会把这条命令创建成普通提问。压缩时请勿附带图片；会话正在运行、启动、加载历史、重试或压缩时会拒绝本次发送，手机端会显示错误并保留草稿。

其他扩展命令和 `/skill:名称` 沿用 pi 的消息通道处理；ACP 会话的命令交给对应 agent，是否支持由该 agent 决定。运行中的会话沿用电脑端的投递方式；ACP 命令会排队到本轮结束后发送。

手机输入框暂不提供斜线命令候选列表。本文中的用法适用于聊天输入框，生图模式请先退出。

## 回归验证

```sh
go test ./internal/workbench -run '^(TestRemoteCompactCommand|TestRemoteCompactCommandRefusals|TestRemoteOtherSlashCommandsReachPi|TestRemoteBusyCommandDelivery)$' -count=1 -timeout=90s
go test ./internal/client -run '^TestMobileSlashCommandSendAndRecover$' -count=1 -timeout=90s
```

测试覆盖手机输入与失败恢复、HTTP 命令分发、压缩附加要求、忙碌与信任校验，以及 ACP 命令的排队处理。使用模拟桌面和 pi 传输，不依赖真实账号或设备；实机验收需另行进行。
