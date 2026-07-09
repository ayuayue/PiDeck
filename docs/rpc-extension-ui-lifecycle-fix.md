# 修复：RPC 模式下 Extension UI 与扩展命令完成状态不一致

## 问题现象

PiDeck 通过 `pi --mode rpc` 启动每个 Agent。用户在 PiDeck 输入扩展注册的斜线命令后，命令可能已经执行完成，但 PiDeck 仍显示 Agent 正在运行，或者显示一个“等待回答”的交互卡片。

典型表现：

- 输入一个只执行 UI 操作的扩展命令后，PiDeck 停留在 running 状态。
- 扩展调用 `ctx.ui.notify()` 后，PiDeck 把通知渲染成需要用户回答的卡片。
- 扩展调用 `ctx.ui.setEditorText()` 后，PiDeck 没有把文本写入输入框，而是可能进入错误的等待交互状态。

## 复现方案

该复现只依赖 Pi RPC 的标准 Extension UI 协议，不依赖外部 TUI、自定义组件或第三方 UI backend。

创建一个 Pi extension：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function extension(pi: ExtensionAPI) {
  pi.registerCommand("ui-fire-and-forget", {
    description: "Exercise fire-and-forget RPC extension UI methods",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Command completed without starting an LLM turn", "info");
      ctx.ui.setStatus("demo", "completed");
      ctx.ui.setEditorText("draft inserted by extension");
    },
  });
}
```

在 PiDeck 中加载该扩展后，发送：

```text
/ui-fire-and-forget
```

期望结果：

- 命令被执行。
- `notify` 显示为通知或轻量提示。
- 输入框文本被设置为 `draft inserted by extension`。
- 没有出现等待用户回答的卡片。
- 如果命令没有启动 LLM 运行，Agent 状态回到 idle。

修复前的结果：

- `notify` 或 `set_editor_text` 可能被当作需要回答的 dialog。
- Agent 可能停留在 running，因为扩展命令完成后不一定会产生 `agent_end` 事件。

### 验证记录

用临时 extension 通过 Pi CLI RPC 模式验证过该行为：

```bash
pi --mode rpc \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-context-files \
  --no-session \
  --approve \
  --model deepseek/deepseek-v4-pro \
  -e <temp-extension.ts>
```

验证结果：

- `/rpc-idle-demo` 只调用 `ctx.ui.notify()` 和 `ctx.ui.setEditorText()`：RPC `prompt` 返回 success，Pi 发出 `notify` 与 `set_editor_text` 两个 `extension_ui_request`，没有 `agent_start` / `agent_end`，随后 `get_state` 返回 `isStreaming=false`、`isCompacting=false`、`pendingMessageCount=0`。
- `/rpc-dialog-demo` 调用 `ctx.ui.confirm(..., { timeout: 200 })`：Pi 发出 dialog request，timeout 后 command handler 继续执行，随后 `get_state` 返回无剩余工作。
- `/rpc-turn-demo` 在 extension command 中调用 `pi.sendUserMessage()`：Pi 发出 `agent_start`，短时间内 `get_state` 返回 `isStreaming=true`，之后正常发出 `agent_end`。这说明 `get_state.isStreaming` 可以阻止 extension command 启动真实 LLM turn 时被过早恢复为 idle。

## 问题分析

### 当前的处理策略

PiDeck 的当前 Agent 运行策略是：

1. `src/main/pi/AgentManager.ts` 发送用户输入前，将 Agent 状态设为 `running`。
2. Pi 子进程通过 stdout 持续发送 RPC events。
3. PiDeck 主要依赖 `agent_end` 事件把 Agent 状态恢复为 `idle`。
4. `extension_ui_request` 中的部分方法被转发到渲染进程；其中 dialog 类请求会写入消息流，作为 `AskQuestionCard` 等待用户回答。

### Gap

Pi RPC 中有两类 Extension UI 请求：

| 类型 | 方法 | 是否需要 `extension_ui_response` |
|---|---|---|
| dialog | `select` / `confirm` / `input` / `editor` | 需要 |
| fire-and-forget | `notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text` | 不需要 |

PiDeck 修复前没有完整区分这两类请求：

- 已特殊处理：`setWidget`、`setStatus`、`setTitle`。
- 未特殊处理：`notify`、`set_editor_text`。
- 未识别的方法会落入 dialog 路径，导致 PiDeck 创建 pending UI 请求和 `AskQuestionCard`。

另一个 gap 是扩展命令生命周期：

- 机制：Pi RPC 的 `prompt` 命令返回成功，只表示 prompt 被接受、排队或已由扩展命令处理；如果输入是扩展命令，Pi 可以直接执行 command handler 并返回，不启动 LLM turn。
- 证据：`@earendil-works/pi-coding-agent/dist/core/agent-session.js` 中：
  - `AgentSession.prompt()` 在进入 `_runAgentPrompt()` 前先调用 `_tryExecuteExtensionCommand()`。
  - 命中扩展命令后执行 `preflightResult?.(true)` 并 `return`，不再调用 `_runAgentPrompt()`。
  - `_tryExecuteExtensionCommand()` 只 `await command.handler(args, ctx)`，不会启动 agent run。
- 推导的处理逻辑：PiDeck 不能只等待 `agent_end` 恢复 idle。对于已确认命中的 extension command，RPC `prompt` 成功返回后需要再查询 `get_state`；只有 Pi 明确报告无剩余工作，且 PiDeck 本地也没有 pending dialog / active assistant / running tool，才恢复 idle。

### 分析问题的缘由（证据）

Pi RPC 文档说明：

- `prompt` 支持扩展命令。消息是扩展命令时，扩展命令会立即执行。
- dialog methods 会发出 `extension_ui_request` 并等待客户端回传同 ID 的 `extension_ui_response`。
- fire-and-forget methods 会发出 `extension_ui_request`，但不等待客户端响应。

可核验来源：

- `@earendil-works/pi-coding-agent/docs/rpc.md`：`Prompting / prompt` 小节说明 extension command 的处理方式。
- `@earendil-works/pi-coding-agent/docs/rpc.md`：`Extension UI Protocol` 小节列出 dialog methods 与 fire-and-forget methods。
- `@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js`：`notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text` 直接输出 `extension_ui_request`，没有加入 pending response map。

PiDeck 侧可核验位置：

- `src/main/pi/AgentManager.ts`：`sendPrompt()` 在发送 RPC prompt 前设置 `runtime.tab.status = "running"`。
- `src/main/pi/AgentManager.ts`：`handlePiEvent()` 在 `agent_end` 分支恢复 idle。
- `src/main/pi/AgentManager.ts`：`handleUIRequest()` 修复前只对 `setWidget`、`setStatus`、`setTitle` 做了非 dialog 处理。

## 解决思路

1. 明确分类 Extension UI request。
   - 只有 `select`、`confirm`、`input`、`editor` 创建 pending UI 请求。
   - `notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text` 不创建 pending UI 请求。
   - 未识别的方法直接忽略，避免误判为 dialog。

2. 扩展命令成功返回后，确认 Pi 是否还有未完成工作。
   - 发送前通过 `get_commands` 判断斜线输入是否命中扩展命令。
   - RPC `prompt` 返回成功后，如果这是扩展命令，则短延迟查询 `get_state`。
   - 只有 Pi 明确返回没有 streaming、没有 compaction、没有 pending message，并且 PiDeck 本地也没有 pending dialog / active assistant / running tool，才将 Agent 状态恢复为 idle。

3. 处理 dialog timeout 的本地残留。
   - Pi RPC dialog 带 `timeout` 时，Pi 会在超时后自行 resolve。
   - PiDeck 需要同步清除本地 pending UI 请求和对应卡片，避免 UI 残留。

4. 在渲染进程实现 host 行为。
   - `notify` 显示为 toast。
   - `set_editor_text` 写入对应 Agent 的 composer 状态。

## 代码变更

### `src/main/pi/AgentManager.ts`

- 新增 `promptMatchesRegisteredExtensionCommand()`：判断当前 prompt 是否命中已注册的 extension command。
- `sendPrompt()` 中：对 extension command 的成功响应安排 `scheduleIdleCheckAfterExtensionCommand()`。
- 新增 `markIdleIfPiReportsNoWork()`：只有 Pi `get_state` 成功返回且显示无剩余工作时，才恢复 idle。
- `handleUIRequest()` 中：
  - `notify` 转发到 renderer，不进入 pending。
  - `set_editor_text` 转发到 renderer，不进入 pending。
  - `setWidget` 保持原有 widget 转发逻辑。
  - `setStatus`、`setTitle` 继续忽略。
  - 只有 `select`、`confirm`、`input`、`editor` 进入 pending dialog。
- 新增 `scheduleUIRequestTimeout()`：dialog 超时后清理本地 pending request 与 AskQuestionCard。

### `src/preload/index.ts`

- 扩展 `onUiRequest` 的 request 类型，包含 `message`、`notifyType`、`text`。

### `src/renderer/src/App.tsx`

- `notify`：显示 toast。
- `set_editor_text`：更新目标 Agent 的 composer 文本；如果目标 Agent 当前激活，同步光标位置。

## 范围边界

本修复不让 PiDeck 原生支持 Pi TUI component factory。Pi RPC 模式下，原生 `ctx.ui.custom()` 仍不可用；如果扩展需要在 RPC 环境运行自定义组件，仍需由扩展自身提供外部 TUI backend 或降级为 host dialog。

对于使用外部 TUI backend 的扩展，本修复覆盖的是外部 TUI 返回后的 PiDeck 状态处理：例如 command 随后调用 `notify` / `setStatus` / `setEditorText`，或 command 同步完成但没有 `agent_end`。

`get_state` 只能证明 Pi 当前没有可观测工作；它不承诺 extension command 返回后不会通过异步 callback 再启动未来工作。如果 extension 在 command handler 返回后才延迟调用 `pi.sendUserMessage()`，PiDeck 可能先短暂恢复 idle，再在后续 `agent_start` 到达时切回 running。

本修复解决的是：PiDeck 对 Pi RPC Extension UI 协议和扩展命令当前生命周期的适配不完整，导致 UI pending 状态和 Agent running 状态残留。
