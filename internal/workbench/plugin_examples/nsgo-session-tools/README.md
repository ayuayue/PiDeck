# 会话统计示例

同一个 NSGo 签名包可以提供原生面板、紧凑组件和无界面函数。测试宿主会编译 `App.tsx`，按 `nsgo.yaml`
描述的身份和权限签名，再验证和加载包。

| 导出 | 宿主入口 | 行为 |
| --- | --- | --- |
| `SessionPanel` | `tsx.View.Export` | 显示后端分布和消息数，可以按需刷新 |
| `SessionBadge` | `tsx.View.Export` | 显示会话数，拥有独立的状态和刷新入口 |
| `readSessionTotals` | `tsx.Load` 和 `Plugin.Call` | 返回相同统计结果，供 Go 宿主调用 |

示例只申请 `sessions.list`。测试通道响应的每一行只有 `backend`（`pi` 或 `acp`）与 `messages`（非负整数）。
每次读取最多 200 行，由 `sessions.ts` 校验并汇总。宿主可收回这项权限，此时面板显示读取失败，函数返回错误。
UI 也演示单个视图加载失败后的回退和关闭后的旧回复处理。

从 PiDeck Lite 仓库根目录运行。

```powershell
go tool nsgo check internal/workbench/plugin_examples/nsgo-session-tools
go test ./internal/workbench -run '^TestNSGoPlugin(NamedView|SessionFunction)' -count=1
```

示例在测试中运行，使用固定测试数据和临时签名密钥。开发者可从 [插件设计](../../../../docs/PLUGINS.md) 查看桌面宿主的接入边界。
