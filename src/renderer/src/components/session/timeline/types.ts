/**
 * 对话时间线领域模型（纯类型，无 React 依赖）。
 *
 * 展示层将一轮 agent-run 展开为「扁平展示序列」（TurnDisplayItem）：
 * - process-entry：思考/工具步骤，原位出现，受 run 级折叠开关控制显隐；
 * - interim-answer：中间回答（本轮非最后一条 assistant 文本），同样受折叠控制；
 * - final-answer：最终回答（本轮最后一条 assistant 文本），常驻、永不折叠。
 *
 * 领域对象类型（AgentRunItem / ThinkingGroupItem / ToolGroupItem）目前暂存于
 * AppUtils.ts，随重构逐步迁移至此；本模块只定义展示层新增类型，避免大爆炸。
 */
import type { AgentRunItem, MessageItem, RetryGroupItem, ThinkingGroupItem, ToolGroupItem } from "../../app/AppUtils";
import type { ChatMessage } from "../../../../../shared/types";

export type { AgentRunItem, MessageItem, RetryGroupItem, ThinkingGroupItem, ToolGroupItem };

/** 单个执行过程条目：思考步骤、工具步骤或自动重试状态。 */
export type TurnProcessEntry = { kind: "thinking-entry"; id: string; group: ThinkingGroupItem } | { kind: "tool-entry"; id: string; group: ToolGroupItem } | { kind: "retry-entry"; id: string; message: ChatMessage };

/** 扁平展示序列中的一个节点。 */
export type TurnDisplayItem = { kind: "process-entry"; entry: TurnProcessEntry } | { kind: "interim-answer"; id: string; message: ChatMessage } | { kind: "final-answer"; id: string; message: ChatMessage };
