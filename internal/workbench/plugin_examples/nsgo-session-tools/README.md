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

桌面设置 → 扩展 → 插件 →「NSGo 插件预览」可以操作同一示例。默认未授权；打开「允许读取演示摘要」后，
面板、徽标与「调用统计函数」使用固定的三条演示摘要，不接触真实会话。关闭、离开设置页和收回权限都会释放实例，
重新打开默认未授权。宿主通过 `copy` props 提供翻译，独立示例保留中文默认值。

桌面仅嵌入 `preview.bundle.json` 的预编译签名包和公钥，后台验证后加载，不携带编译器或私钥。
资源公钥只为这个内置例子服务，不授信外部包。修改源码或清单后，从仓库根目录显式生成资源：

```powershell
go test ./internal/workbench -run '^TestPluginPreviewBundleCurrent$' -update-plugin-preview
go test ./internal/workbench -run '^(TestPluginPreview|TestNSGoPlugin)' -count=1
```

普通测试会比较签名包与当前源码的编译结果、身份和权限，发现过期资源即失败。生成密钥仅在测试进程中存在，
文件不保留私钥。开发者可从 [插件设计](../../../../docs/PLUGINS.md) 查看外部包的接入边界。
