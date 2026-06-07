# pi-desktop v0.4.6

这是一次 Provider 配置和命令体验的增强版本。

## 新增
- Provider 模型发现：可直接从已配置的供应商接口拉取可用模型列表。
- Provider 连接测试：启动 agent 前可用最小请求验证 Base URL、API Key、模型 ID、自定义 headers、延迟和 token 用量。
- Provider 管理增强：Models 页支持重命名 provider，并可视化配置请求 headers / User-Agent。

## 优化
- API 类型兼容：移除非 pi 官方的 `openai-chat-completions` 预设，将历史别名迁移为 `openai-completions`，避免“测试通过但会话启动提示 No API provider registered”。
- 斜线命令和文件建议支持键盘选择，输入框操作更顺滑。
- 增加 OpenAI Responses 兼容处理，包括为会校验客户端 headers 的 provider 模拟 SDK User-Agent。
- 同步更新配置预览 mock 和 IPC 契约，覆盖 provider 模型拉取与测试流程。

## 验证
- 已通过 `npm run typecheck`。
- 已通过 `npm run dist:win` 并生成 Windows 安装包、便携版和 zip。