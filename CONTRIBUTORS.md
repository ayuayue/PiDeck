# 贡献者

感谢所有为 PiDeck 做出贡献的人！

<!-- 按首次贡献时间排序 -->

- **1900EasonJin** ([@1900EasonJin](https://github.com/1900EasonJin)) — 飞书/Lark 远程控制集成、记忆管理卡片、Thinking 节流优化、侧栏卡片化重设计、草稿本浮层、终端乱码修复、系统标题栏侧栏开关、宠物状态卡死修复 (#107, #104, #80, #74, #60, #44, #42, #35, #34, #31, #30, #29, #28, #18)
- **zx3022448** ([@zx3022448](https://github.com/zx3022448)) — 模型列表拉取优化及错误状态展示、模型选择器改进、支持从 Claude Code / Codex 导入 MCP 与技能资源 (#221, #25, #19)
- **frostime** ([@frostime](https://github.com/frostime)) — 会话信息同步、自定义字体/字号与缩放比例、模型选择器自动滚动、最大推理等级、RPC 扩展 UI 生命周期修复 (#58, #56, #53, #52, #50)
- **magic2066** ([@magic2066](https://github.com/magic2066)) — 修复 Codex 子代理会话导入展示、修复 Linux 桌面宠物拖拽和 dev 启动 (#40, #41)
- **pangolinknight** ([@pangolinknight](https://github.com/pangolinknight)) — 主进程流式消息节流合并与工具结果截断，修复大会话渲染进程白屏 (#33)
- **me9rez** ([@me9rez](https://github.com/me9rez)) — 清理依赖、SkillManager 软连接扫描与循环检测、TypeScript 增量编译产物整理 (#97, #86, #69)
- **bfzha** ([@bfzha](https://github.com/bfzha)) — VS Code 风格 Git 面板与复杂工作流支持、会话内存瘦身与流式渲染优化、时间线查看位置保持、技能/提示词/扩展启停开关、资源作用域与 pi 0.85 解析器对齐 (#68, #145, #144, #143, #142, #141)、运行控制「停止回答 / 关闭 Agent」语义拆分、内置 Web 服务默认绑环回并强制令牌鉴权、shell 操作符不再渲染成会话 chip、状态图标防裁切与 Ask 等待提示档位、提问卡钉列底 + 整行选项重做 (#230)、pi 0.86 system 条目导致的 entryId 错位修复、重试成功卡改瞬态卡
- **Lopution** ([@Lopution](https://github.com/Lopution)) — 跨桌面边界 WSL 路径处理 (#84)
- **buaassp** ([@buaassp](https://github.com/buaassp)) — 隐藏内部 pi-subagent 会话 (#57)
- **octo-patch** ([@octo-patch](https://github.com/octo-patch)) — MiniMax 端点认证专属模型发现 (#112)
- **zzq168281-coder** ([@zzq168281-coder](https://github.com/zzq168281-coder)) — 本地文件链接可交互、todo 挂件字体跟随界面设置 (#103)
- **weishiair** ([@weishiair](https://github.com/weishiair)) — 禁用/冲突让位时删除内置扩展用户目录文件，避免第三方扩展工具冲突导致 RPC 失败
- **clancyclaw** ([@clancyclaw](https://github.com/clancyclaw)) — 修复 RichInput 换行被吞掉，保证多行草稿完整保留
- **c834292137** ([@c834292137](https://github.com/c834292137)) — 统一会话组件卡（待办/子代理/文件修改）并聚合共享层 (#171)
- **r0y1z2** ([@r0y1z2](https://github.com/r0y1z2)) — 项目会话置顶、输入框安全语音转写 (#177, #176)、Windows 资源管理器右键「小任务」紧凑窗口 (#243)
- **sgafxh** ([@sgafxh](https://github.com/sgafxh)) — 请求体超限后的会话恢复、修复 Windows 启动 pi 闪 CMD 窗口 (#188, #180)
- **lerrorgk** ([@lerrorgk](https://github.com/lerrorgk)) — 修复 nicobailon pi-subagents 异步派发误标完成，面板条目补齐全任务描述 (#206)
- **juzijun233** ([@juzijun233](https://github.com/juzijun233)) — 稳定性与安全加固系列：主进程登录 shell PATH 探测改异步预热（消除启动冻结）、停止后迟到流式事件按无 runtime 拒绝、事件载荷补齐 sessionId + runtimeGeneration、主进程直发渲染层收敛到已订阅通道白名单、超大 diff 截断、PiRpcClient 行缓冲上限、Git 写操作校验 commit hash 与 reset 模式、渲染层按会话订阅隔离（分屏互不牵连）、webview 死属性与多余 any 断言清理
- **xiaYuTian11** ([@xiaYuTian11](https://github.com/xiaYuTian11)) — 侧栏项目树显示当前 Git 分支 (#232)、时间线滚动抖动与切会话跳顶跳底修复 (#224)、会话 Tab 宽度上限与字号调整 (#226)、技能重命名按类型分流以免搬走技能根目录 (#227)
- **Q-xuan** ([@Q-xuan](https://github.com/Q-xuan)) — 行内代码里的文件引用重新可点 (#228)、修复 LaTeX 括号公式渲染 (#251)

以及所有提交 Issue、反馈建议和帮助推广的用户。

## 💖 特别支持

- **微时佬友** ([@weishiair](https://github.com/weishiair)) — 提供 Grok 模型服务，用于 PiDeck 的软件开发 🎉

---

如果你想贡献代码，欢迎提交 Pull Request！查看 [开发指南](docs-site/guide/development.md) 了解如何从源码运行。
