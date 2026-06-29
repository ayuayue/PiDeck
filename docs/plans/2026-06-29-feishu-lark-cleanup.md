# 飞书连接架构清理与 pi-feishu-lark 删除计划

> **For agents:** 执行前先确认用户同意；本计划只清理无运行依赖的 `pi-feishu-lark` 残留，不删除官方 `@larksuiteoapi/node-sdk`。

**Goal:** 明确 `pi-feishu-lark` 在 PiDeck 中的真实作用，安全删除无效残留，并降低当前飞书连接架构的耦合度。  
**Architecture:** PiDeck 当前飞书能力已经内置在 `src/main/feishu/`，通过 Electron IPC 与前端 `useFeishuBridge` 通信；`pi-feishu-lark` 只作为历史参考项目存在，不参与运行链路。清理应先删除引用与文档误导，再分阶段拆分 `FeishuBridge` 的职责。  
**Tech Stack:** Electron、React、TypeScript、`@larksuiteoapi/node-sdk`、Pi RPC Agent。

---

## 目录

- [0. 执行记录](#0-执行记录)
- [1. 当前结论](#1-当前结论)
- [2. 删除边界](#2-删除边界)
- [3. 现有运行链路](#3-现有运行链路)
- [4. 主要架构问题](#4-主要架构问题)
- [5. 修改目标](#5-修改目标)
- [6. 分阶段执行计划](#6-分阶段执行计划)
- [7. 验证命令](#7-验证命令)
- [8. 风险与回滚](#8-风险与回滚)
- [9. 执行前确认清单](#9-执行前确认清单)

---

## 0. 执行记录

执行时间：2026-06-29

已完成：

- 已确认 `package.json` / `package-lock.json` 没有 `pi-feishu-lark` 依赖；
- 已保留官方 `@larksuiteoapi/node-sdk`；
- 已将外部参考目录归档到 `/Users/1900th/Downloads/同步空间/Pi Agent/_archive/pi-feishu-lark-archived-2026-06-29`；
- 已把 `src/main/feishu/` 中旧项目名注释改成“历史/早期飞书桥接实现”；
- 已把维护手册中的旧项目描述改成“历史参考实现，不参与 PiDeck 运行”；
- 已运行 `npm run typecheck`，结果为 0 errors。

未执行：

- 未删除官方飞书 SDK；
- 未重构 `FeishuBridge`；
- 未提交 Git commit。

---

## 1. 当前结论

### 1.1 `pi-feishu-lark` 可以删除吗？

可以，但只删除“历史参考项目/残留目录”，不要删除官方飞书 SDK。

当前检查结果：

```txt
package.json 中存在: @larksuiteoapi/node-sdk
package.json 中不存在: pi-feishu-lark
当前项目内没有 import pi-feishu-lark
当前工作目录外发现参考项目: ../飞书远程控制/pi-feishu-lark
```

也就是说：

- `pi-feishu-lark` 不是 PiDeck 运行时依赖；
- PiDeck 真正使用的是官方 SDK：`@larksuiteoapi/node-sdk`；
- `pi-feishu-lark` 现在主要作为历史参考、文档说明、注释来源存在；
- 如果删除 `../飞书远程控制/pi-feishu-lark`，PiDeck 代码本身不会因为缺包而无法编译。

### 1.2 不能删除什么？

不能删除：

```txt
@larksuiteoapi/node-sdk
src/main/feishu/*
src/renderer/src/hooks/useFeishuBridge.ts
src/renderer/src/components/feishu/*
src/main/index.ts 中 registerFeishuIpc 相关逻辑
src/shared/ipc.ts 中 feishu:* IPC 通道
src/shared/types.ts 中 Feishu* 类型
```

这些才是 PiDeck 当前飞书功能的实际运行部分。

---

## 2. 删除边界

### 2.1 建议删除/归档

目标对象：

```txt
../飞书远程控制/pi-feishu-lark
```

建议先归档再删除：

```bash
cd /Users/1900th/Downloads/同步空间/Pi\ Agent
mkdir -p _archive
mv 飞书远程控制/pi-feishu-lark _archive/pi-feishu-lark-archived-2026-06-29
```

如果用户明确要求彻底删除，再执行：

```bash
rm -rf /Users/1900th/Downloads/同步空间/Pi\ Agent/_archive/pi-feishu-lark-archived-2026-06-29
```

### 2.2 建议改名/修正文档引用

当前文档中 `pi-feishu-lark` 容易误导读者，以为它仍参与运行。建议把文档描述改成“历史参考实现”。

涉及文件：

```txt
docs/飞书远程控制-维护手册.md
src/main/feishu/CardStream.ts
src/main/feishu/TaskStatusCard.ts
src/main/feishu/rich-text.ts
```

处理方式：

- 文档保留历史说明，但明确“已不参与 PiDeck 运行”；
- 注释中“从 pi-feishu-lark 移植”改成“参考历史实现”；
- 不改运行逻辑。

---

## 3. 现有运行链路

### 3.1 配置页/输入框入口

```txt
FeishuLinkIndicator.tsx / ImTab.tsx
        ↓
useFeishuBridge.ts
        ↓
window.piDesktop.feishu
        ↓
preload/index.ts
        ↓
ipcChannels.feishu:*
```

### 3.2 主进程入口

```txt
src/main/index.ts
        ↓
registerFeishuIpc()
        ↓
全局 feishuBridge: FeishuBridge | null
        ↓
src/main/feishu/FeishuBridge.ts
```

### 3.3 飞书 SDK 调用

```txt
FeishuBridge.start()
        ↓
import("@larksuiteoapi/node-sdk")
        ↓
new lark.Client(...)
new lark.WSClient(...)
new lark.EventDispatcher(...)
```

### 3.4 飞书消息到 Agent

```txt
飞书消息
  → WSClient
  → EventDispatcher
  → FeishuBridge.handleRawMessage()
  → FeishuBridge.handleMessage()
  → FeishuBridge.runAgent()
  → AgentManager.sendPrompt()
```

### 3.5 PiDeck 会话同步到飞书

```txt
PiDeck 输入消息
  → src/main/index.ts agentsPrompt handler
  → feishuBridge.hasSessionBinding(agentId)
  → feishuBridge.startSessionMirrorRun(...)
  → feishuBridge.forwardUserMessageToFeishu(...)
  → AgentManager.sendPrompt(...)
  → AgentManager local event
  → FeishuBridge.handleAgentEvent(...)
  → syncPiMessageToFeishu(...)
```

---

## 4. 主要架构问题

### 4.1 `FeishuBridge` 过大

当前 `src/main/feishu/FeishuBridge.ts` 约 1500 行，同时负责：

- Bot 连接；
- WebSocket 事件监听；
- 飞书消息解析；
- 命令处理；
- Agent 会话创建/恢复；
- PiDeck 会话镜像到飞书；
- 群聊创建/复用；
- 绑定持久化；
- 流式卡片；
- 文件、图片、文档处理；
- Renderer 状态推送。

这导致任何小改动都容易影响其它链路。

### 4.2 全局 Bot 连接与会话级绑定混用

当前只有一个全局 `feishuBridge`：

```ts
let feishuBridge: FeishuBridge | null = null;
```

但前端又支持“当前会话选择 Bot”。结果是：

- 会话选择 Bot 时，会切换全局 Bridge；
- 全局 Bridge 切换会影响其它会话；
- `activeBotId`、`sessionBotId`、`bindings` 三个状态容易不一致。

### 4.3 断开绑定后仍可能复用旧群

`FeishuConfig.ts` 中存在独立持久映射：

```txt
feishu-session-chat.json
```

它保存：

```txt
sessionPath → chatId
agent:<sessionId> → chatId
```

设计目的是避免重复建群，但副作用是：

- 用户断开当前会话绑定后；
- 后续重新连接同一会话；
- 仍可能复用旧群；
- 用户会以为“飞书没有真正断开”。

### 4.4 `source: feishu` 与 `source: session-mirror` 逻辑缠在一起

当前绑定类型：

```ts
source: "feishu" | "session-mirror"
```

两种模式语义不同：

- `feishu`：从飞书发起会话；
- `session-mirror`：从 PiDeck 会话同步到飞书群。

但它们共用同一批 map、同一套恢复逻辑、同一个 `FeishuBridge`，所以判断条件变复杂。

---

## 5. 修改目标

### 5.1 第一目标：安全删除 `pi-feishu-lark` 残留

结果应满足：

- PiDeck 不再出现“`pi-feishu-lark` 好像仍在运行”的误导；
- 删除或归档外部参考目录；
- 文档和注释明确它只是历史参考；
- `npm run typecheck` 通过。

### 5.2 第二目标：让“断开飞书”语义清楚

建议定义两种操作：

| 操作 | 行为 |
|---|---|
| 断开当前会话 | 删除当前会话 binding 与 session-bot 映射，不再同步消息 |
| 忘记飞书群 | 同时删除 `sessionPath → chatId` 持久映射，下次重新连接会建新群 |

第一阶段可以只做“文案和逻辑说明”，第二阶段再加 UI 按钮。

### 5.3 第三目标：拆分 `FeishuBridge`

最小拆分，不重写功能：

```txt
FeishuConnection
  只管 @larksuiteoapi/node-sdk client/ws 生命周期

FeishuBindingStore
  只管 bot、binding、session-bot、session-chat 持久化

FeishuMessageRouter
  只管飞书消息解析、命令路由、附件处理

FeishuSessionMirror
  只管 PiDeck 会话 ↔ 飞书群同步

FeishuBridge
  变成协调器，保留对外 API，减少业务细节
```

---

## 6. 分阶段执行计划

## Phase 0：保护当前工作区

当前 `git status --short` 已显示有未提交改动：

```txt
 M src/main/feishu/FeishuBridge.ts
 M src/main/feishu/types.ts
 M src/renderer/src/components/feishu/FeishuConnectDialog.tsx
?? issue-multiline-bug.md
```

执行任何清理前先确认这些改动是不是用户正在做的内容。未经用户明确允许，不覆盖、不回滚、不提交。

- [ ] Step 0.1：查看当前差异范围

```bash
git status --short
git diff -- src/main/feishu/FeishuBridge.ts src/main/feishu/types.ts src/renderer/src/components/feishu/FeishuConnectDialog.tsx
```

- [ ] Step 0.2：确认是否基于当前改动继续

预期结果：用户确认“继续”或要求先处理已有改动。

---

## Phase 1：确认 `pi-feishu-lark` 没有运行依赖

- [ ] Step 1.1：搜索项目内引用

```bash
rg -n "pi-feishu-lark|feishu-lark|@larksuiteoapi/node-sdk" package.json package-lock.json src docs README.md README.en.md CHANGELOG.md CHANGELOG.zh-CN.md
```

预期结果：

```txt
@larksuiteoapi/node-sdk 只作为官方 SDK 存在
pi-feishu-lark 只出现在文档/注释中
src 中没有 import pi-feishu-lark
```

- [ ] Step 1.2：确认 package 中没有 `pi-feishu-lark`

```bash
node - <<'NODE'
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
console.log('dependencies.pi-feishu-lark =', p.dependencies?.['pi-feishu-lark'] ?? null);
console.log('devDependencies.pi-feishu-lark =', p.devDependencies?.['pi-feishu-lark'] ?? null);
console.log('dependencies.@larksuiteoapi/node-sdk =', p.dependencies?.['@larksuiteoapi/node-sdk'] ?? null);
NODE
```

预期结果：

```txt
dependencies.pi-feishu-lark = null
devDependencies.pi-feishu-lark = null
dependencies.@larksuiteoapi/node-sdk = ^1.67.0
```

---

## Phase 2：归档外部 `pi-feishu-lark` 参考目录

- [ ] Step 2.1：确认目录存在

```bash
test -d /Users/1900th/Downloads/同步空间/Pi\ Agent/飞书远程控制/pi-feishu-lark && echo exists
```

预期结果：

```txt
exists
```

- [ ] Step 2.2：先归档，不直接删除

```bash
cd /Users/1900th/Downloads/同步空间/Pi\ Agent
mkdir -p _archive
mv 飞书远程控制/pi-feishu-lark _archive/pi-feishu-lark-archived-2026-06-29
```

预期结果：

```txt
/Users/1900th/Downloads/同步空间/Pi Agent/_archive/pi-feishu-lark-archived-2026-06-29 存在
/Users/1900th/Downloads/同步空间/Pi Agent/飞书远程控制/pi-feishu-lark 不存在
```

- [ ] Step 2.3：如果用户明确要求彻底删除，再删除归档目录

```bash
rm -rf /Users/1900th/Downloads/同步空间/Pi\ Agent/_archive/pi-feishu-lark-archived-2026-06-29
```

预期结果：归档目录不存在。

---

## Phase 3：修正文档和注释，避免误导

- [ ] Step 3.1：修改维护手册中的角色说明

文件：

```txt
docs/飞书远程控制-维护手册.md
```

建议把：

```md
| **pi-feishu-lark** | `pi-feishu-lark/` | Pi CLI 的原生扩展（npm 包），参考实现 |
```

改成：

```md
| **pi-feishu-lark** | 已归档/可删除 | 历史参考实现，不参与 PiDeck 运行 |
```

并保留说明：

```md
PiDeck 当前飞书功能完全由 `src/main/feishu/` 和 `@larksuiteoapi/node-sdk` 提供，`pi-feishu-lark` 不再作为运行时依赖。
```

- [ ] Step 3.2：修改源码注释

文件：

```txt
src/main/feishu/CardStream.ts
src/main/feishu/TaskStatusCard.ts
src/main/feishu/rich-text.ts
```

建议把“从 pi-feishu-lark 移植/参考 pi-feishu-lark”统一改成：

```txt
参考早期飞书桥接实现
```

保留 API 说明，不保留旧项目名称，避免误判为运行依赖。

---

## Phase 4：梳理断开飞书的语义

- [ ] Step 4.1：给现有行为补充注释

文件：

```txt
src/main/feishu/FeishuConfig.ts
src/main/feishu/FeishuBridge.ts
```

需要说明：

```txt
removeBinding 只取消当前绑定，不删除 sessionPath → chatId 持久映射。
这样做会复用旧群，避免重复建群。
```

- [ ] Step 4.2：新增“忘记飞书群”的内部方法设计

建议后续新增方法：

```ts
forgetPersistentChatId(sessionPath: string): void
forgetPersistentAgentChatId(agentId: string): void
```

对应删除：

```txt
feishu-session-chat.json 中的 sessionPath key
feishu-session-chat.json 中的 agent:<sessionId> key
```

第一轮不实现 UI，只先把语义设计清楚。

---

## Phase 5：后续小步拆分 `FeishuBridge`

这部分不建议和删除 `pi-feishu-lark` 同一个 PR 做，避免范围过大。

### Task 5.1：抽出连接层 `FeishuConnection`

目标文件：

```txt
src/main/feishu/FeishuConnection.ts
```

职责：

```txt
创建 Lark Client
创建 WSClient
注册 EventDispatcher
stop 连接
测试凭证
获取 botOpenId
```

`FeishuBridge` 保留：

```ts
start()
stop()
testConnection()
```

但内部委托给 `FeishuConnection`。

### Task 5.2：抽出绑定存储 `FeishuBindingStore`

目标文件：

```txt
src/main/feishu/FeishuBindingStore.ts
```

职责：

```txt
chatBindings
sessionToChat
loadPersistedBindings
persistBindings
removeBinding
updateBinding
```

### Task 5.3：抽出会话镜像 `FeishuSessionMirror`

目标文件：

```txt
src/main/feishu/FeishuSessionMirror.ts
```

职责：

```txt
ensureSessionMirror
startSessionMirrorRun
stopSessionMirrorRun
forwardUserMessageToFeishu
syncPiMessageToFeishu
```

### Task 5.4：保留 `FeishuBridge` 为协调器

`FeishuBridge` 最终只保留：

```txt
生命周期 API
Renderer 状态推送
飞书消息入口
AgentManager 事件入口
对子模块的依赖注入
```

---

## 7. 验证命令

每个阶段完成后至少运行：

```bash
npm run typecheck
```

如果改了渲染组件，再运行：

```bash
npm run lint
```

如果项目没有 lint 脚本，以 `package.json` 实际 scripts 为准：

```bash
node -e "console.log(require('./package.json').scripts)"
```

最终检查：

```bash
rg -n "pi-feishu-lark|feishu-lark" src docs README.md README.en.md CHANGELOG.md CHANGELOG.zh-CN.md package.json package-lock.json
```

预期结果：

```txt
仅文档中允许出现“历史参考实现”说明；src 中不再出现旧项目名。
```

---

## 8. 风险与回滚

### 8.1 删除外部目录的风险

风险：后续想对照旧实现时不方便。  
缓解：先移动到 `_archive`，不要直接 `rm -rf`。

回滚命令：

```bash
cd /Users/1900th/Downloads/同步空间/Pi\ Agent
mv _archive/pi-feishu-lark-archived-2026-06-29 飞书远程控制/pi-feishu-lark
```

### 8.2 文档改名的风险

风险：维护手册里的历史对照链接变少。  
缓解：保留 GitHub 链接或归档路径说明，不保留“当前运行项目”的表述。

### 8.3 拆分 `FeishuBridge` 的风险

风险：消息同步、卡片流、绑定恢复任一链路回归。  
缓解：拆分单独 PR，不和删除残留一起做；每拆一个模块只移动代码，不改变行为。

---

## 9. 执行前确认清单

- [ ] 用户确认可以处理当前工作区已有改动；
- [ ] 用户确认 `../飞书远程控制/pi-feishu-lark` 先归档还是直接删除；
- [ ] 用户确认本轮只做“删除残留 + 文档注释清理”，不做大重构；
- [ ] 执行后运行 `npm run typecheck`；
- [ ] 完成后汇报变更文件和验证结果；
- [ ] 不自动 `git add`、`git commit`、`git push`，除非用户明确要求。
