/**
 * 非组件工具函数，与 AppParts.tsx 分离以避免 Vite Fast Refresh 报错。
 * Fast Refresh 只支持组件和 hook（useXxx）导出，普通函数导出会导致整页刷新。
 *
 * 2026-11 拆分（纯搬迁，零行为变化）：实现按域搬进 `./appUtils/*`，本文件只做转发。
 * 调用方继续 `import { … } from "./AppUtils"`——说明符不变是这波搬迁的零风险前提，
 * 不要为了「就近」把调用点改成直连域文件，否则又退回一张分散的入口网。
 * 新增工具函数时先按域挑文件：拖拽负载 / 文本与时间 / 路径 / 分组类型 / 渲染等价 /
 * 列表复用 / 分组装配 / 大纲 / 建议触发 / 命令菜单 / 建议构造 / 工具参数。
 */

// ANSI 净化与工具参数解析的唯一实现在 shared/；本文件只转出旧名字，避免调用点大面积改动。
export { stripAnsiCsi as stripAnsi } from "../../../../shared/ansiText";
export { parseToolArgs } from "../../../../shared/toolArgs";

/* ── 文件树拖拽负载 ── */
export { fileNodeDragPayloadToRef, PI_FILE_NODE_DRAG_MIME, PI_FILE_PATH_DRAG_MIME, readFileNodeDragPayload, writeFileNodeDragPayload } from "./appUtils/fileNodeDrag";
export type { FileNodeDragPayload } from "./appUtils/fileNodeDrag";

/* ── 文本清理 / 时间与摘要 ── */
export { formatTime, stripThinkingTags, summarizeMessage } from "./appUtils/textFormat";

/* ── 路径与匹配 ── */
export { displayPath, flattenFiles, matches } from "./appUtils/pathMatch";

/* ── 消息分组类型 ── */
export type { AgentRunItem, ErrorGroupItem, ExtensionEntryGroupItem, MessageItem, RenderMessage, RetryGroupItem, ThinkingGroupItem, ToolGroupItem } from "./appUtils/renderTypes";

/* ── 渲染等价 / 列表复用 ── */
export { getMultiSelectImageCaptureIds, sameAgentRunForRender, sameChatMessageForRender } from "./appUtils/renderEquality";
export { reconcileRuns } from "./appUtils/reconcileRuns";

/* ── 消息分组 ── */
export { groupToolMessages, messageEndedAt } from "./appUtils/groupMessages";

/* ── 会话大纲 ── */
export { buildOutline } from "./appUtils/outline";
export type { OutlineItem } from "./appUtils/outline";

/* ── 输入框建议 ── */
export { applySuggestion, clearSuggestionTrigger, detectTrigger } from "./appUtils/composerTrigger";
export type { ComposerSuggestionResult, ComposerTrigger } from "./appUtils/composerTrigger";
export { buildSuggestionItems } from "./appUtils/suggestionItems";
export type { SuggestionItem } from "./appUtils/suggestionItems";
export { DSH_COMMAND_SUGGESTIONS, mergeCommands } from "./appUtils/commandMenu";

/* ── 工具参数 ── */
export { countTextLines, getToolChangedLineCount, getToolEditDiff, getToolFilePath, getToolNewContent } from "./appUtils/toolArgs";
