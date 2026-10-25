---
id: 2026-09-20-dsml-toolcall-workaround
title: 偶发「回复变成一坨工具调用标记」的说明与临时处理
level: warn
category: flash
publishedAt: 2026-09-20T12:00:00+08:00
effectiveUntil: 2026-10-11T23:59:00+08:00
---
近期有用户反馈：**偶发某一轮回复变成一坨标记文本（形如带 `DSML` 字样的标记块），并且那一轮的工具根本没有执行**。

**原因**：这是模型 / 中转站侧的问题——DeepSeek 系模型的原生工具调用标记没有被中转站转换成结构化的工具调用，pi 只能把它当普通文本收下，界面就照原样显示出来了。它在 pi 0.86 之前就出现过，**不是 0.86 引入的**；但 pi 0.86 起会给内置工具（read / bash / edit / write）发送 strict JSON-schema 定义，会让「不认 strict 的中转站」更容易踩到这个毛病。

**临时处理（不需要更新客户端）**：给走 openai-completions 的中转站关掉严格工具采样。

1. 打开「设置 → 源文件」，下拉选 `models.json`；
2. 找到对应供应商，在它的 `compat` 里加一行 `"supportsStrictMode": false`（原有键保持不动）；
3. 保存后**重启 PiDeck**（或新建会话）才生效。

加好之后该供应商的 compat 形如：

```json
"compat": {
  "supportsDeveloperRole": false,
  "supportsReasoningEffort": true,
  "supportsStrictMode": false
}
```

**注意**：

- 这个开关**只对 API 类型为 openai-completions 的供应商有效**。
- 如果你的供应商是 openai-responses（部分中转站），加这个键不起作用，但**不代表不会出现**这个问题：可以先直接重发一次；也可以把该供应商的 API 类型改成 openai-completions（改完建议同时把 `supportsStrictMode` 设为 `false`）。
- 它**不能 100% 消除**，这是上游的偶发行为；遇到时**重发一次**通常就正常了。

**处理进度**：开发版本**已经完成兼容处理**，供应商设置里会直接提供这个开关，不用再改源文件。**正式版本会尽快发布**，升级之后即可忽略本说明。

给你带来不便非常抱歉，有问题欢迎到「设置 → 问题反馈」或反馈交流群告诉我们。
