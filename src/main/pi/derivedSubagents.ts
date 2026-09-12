/**
 * 工具调用推导子代理条目：从会话文件消息流推导「不走 @tintinweb/pi-subagents
 * record/事件链」的子代理运行，作为 record/桥接之外的兜底源。
 *
 * 当前覆盖两条委托链：
 *
 * 1. acp_delegate（billion-context-pi 插件）：独立 spawn pi 子进程运行，不写
 *    subagents:record、不发插件事件，自带的运行状态 widget 仅 TUI 模式激活
 *    （PiDeck 为 RPC 模式收不到）。父会话文件里唯一的痕迹是三类条目：
 *    - assistant 消息里的 toolCall（name=acp_delegate*，arguments 携带 agent/task/runId）；
 *    - role=toolResult 的派发确认文本（含 runId `del_xxx`，把 runId 关联到 toolCallId）；
 *    - role=user 的终态系统通知（"[acp_delegate completed]" / "[acp_delegate FAILED ⚠️]"，
 *      失败时错误摘录嵌在 Output: ~~~ 围栏块中）。
 *
 * 2. subagent 工具（nicobailon 的 pi-subagents 插件，npm 无 scope 包）：工具名为
 *    "subagent"（注意 @tintinweb 版的工具名是 "Agent"，其历史由 record/锚点覆盖）。
 *    单任务派发（args 有 agent+task、无 action/workflow 字段）按配对 toolResult 分流：
 *    前台结果携带最终报告全文，直接推导终态；异步回执（含 "The async run is
 *    detached" 引导文，覆盖 asyncByDefault/forceTopLevelAsync 运行时强制后台、模型
 *    args 不带 async:true 的场景）不足终态——把条目重键为回执中的 asyncId 并保持
 *    running。asyncId 与 subagent-async widget 的 run.id 同源，渲染层按 id 合并去重
 *    （旧设计因派发用 toolCallId、widget 用 asyncId 导致双行而放弃推导，重键后解决），
 *    且派发 args.task 的描述文本可补充给无 task 文本的 widget 条目。
 *
 * 推导条目 source 为 "toolcall"（live 降级逻辑见 downgradeStaleRunning；异步条目
 * 的终态只能降到 stopped——完成通知是 custom_message/subagent-notify 且单任务不带
 * runId，无法可靠关联回 asyncId，历史会话只能识别到「已不在运行」）。
 * acp 条目 id 固定用派发 toolCallId（acp_delegate_xxx），与桥接扩展落盘的
 * record/锚点 id 对齐；runId 只用于把终态通知/取消关联回派发条目。
 *
 * @module derivedSubagents
 */

import type { PiSubagentEntry, PiSubagentStatus } from "../../shared/types";

const ACP_DELEGATE_TOOL = "acp_delegate";
const ACP_CANCEL_TOOL = "acp_delegate_cancel";
const SUBAGENT_TOOL = "subagent";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TERMINAL_STATUSES = new Set<PiSubagentStatus>([
	"completed", "error", "stopped", "aborted", "steered",
]);

/** content 归一化为纯文本（string 直返；数组只拼接 text 项，工具调用/思考块忽略）。 */
export function extractEntryText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const item of content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
			out += item.text;
		}
	}
	return out;
}

/**
 * nicobailon pi-subagents 异步派发回执特征：派发立即返回、运行转后台。交互/非交互
 * 两种引导文都以 "The async run is detached" 开头，作为回执判定标记。
 */
const ASYNC_RECEIPT_MARKER = "The async run is detached";

/** 回执首段中携带 asyncId 的行："Async: worker [uuid]" / "Async workflow [id]" 等。 */
const ASYNC_ID_LINE_RE = /^Async[^\n]*\s\[([^\]\s]+)\]$/m;

/** 判断 subagent 工具结果是否为异步派发回执（非最终报告）。 */
export function isAsyncDispatchReceipt(text: string): boolean {
	return text.includes(ASYNC_RECEIPT_MARKER);
}

/** 从回执文本提取 asyncId（与 subagent-async widget 的 run.id 同源）；提取失败返回 undefined。 */
export function extractAsyncRunId(text: string): string | undefined {
	return ASYNC_ID_LINE_RE.exec(text)?.[1];
}

/** 派发确认 / 系统通知文本中的 runId（形如 runId `del_xxx`）。 */
export function extractAcpRunId(text: string): string | undefined {
	const match = /runId `([^`]+)`/.exec(text);
	return match?.[1];
}

/** FAILED 通知中的错误摘录（Output: ~~~ 围栏块）；截断 2000 字符与 record 预览对齐。 */
export function extractAcpErrorExcerpt(text: string): string | undefined {
	const match = /Output:\s*\n?~~~\n?([\s\S]*?)~~~/.exec(text);
	const excerpt = match?.[1]?.trim();
	return excerpt ? excerpt.slice(0, 2000) : undefined;
}

/**
 * 从会话文件原始条目（已 JSON.parse 的 JSONL 行）推导 acp_delegate 子代理条目。
 *
 * 纯函数：不关心分支/压缩等索引概念，按文件顺序扫（委托审计语义与 record 读取
 * 一致：不随对话分支回退丢失）。损坏条目由调用方过滤；字段缺失的条目跳过。
 */
export function deriveAcpDelegateEntries(
	rawEntries: readonly unknown[],
): PiSubagentEntry[] {
	const byId = new Map<string, PiSubagentEntry>();
	// runId → 派发 toolCallId：终态通知/取消只带 runId，需要这层反查
	const entryIdByRunId = new Map<string, string>();

	for (const raw of rawEntries) {
		if (!isRecord(raw) || raw.type !== "message" || !isRecord(raw.message)) continue;
		const message = raw.message;
		const timestampMs = typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : NaN;
		const role = typeof message.role === "string" ? message.role : "";

		if (role === "assistant" && Array.isArray(message.content)) {
			for (const item of message.content) {
				if (!isRecord(item) || item.type !== "toolCall") continue;
				const toolName = typeof item.name === "string" ? item.name : "";
				const toolCallId = typeof item.id === "string" ? item.id : "";
				if (!toolCallId) continue;
				if (toolName === ACP_DELEGATE_TOOL) {
					// 幂等：同 id 重放（fork 重放等）保留首条
					if (byId.has(toolCallId)) continue;
					const args = isRecord(item.arguments) ? item.arguments : {};
					byId.set(toolCallId, {
						id: toolCallId,
						type: typeof args.agent === "string" && args.agent ? args.agent : ACP_DELEGATE_TOOL,
						description: typeof args.task === "string" ? args.task : "",
						status: "running",
						startedAt: Number.isFinite(timestampMs) ? timestampMs : undefined,
						source: "toolcall",
						via: "acp-delegate",
					});
				} else if (toolName === ACP_CANCEL_TOOL) {
					const args = isRecord(item.arguments) ? item.arguments : {};
					const runId = typeof args.runId === "string" ? args.runId : "";
					const entryId = runId ? entryIdByRunId.get(runId) : undefined;
					const entry = entryId ? byId.get(entryId) : undefined;
					if (!entry || TERMINAL_STATUSES.has(entry.status)) continue;
					entry.status = "stopped";
					if (Number.isFinite(timestampMs)) entry.completedAt = timestampMs;
				}
			}
			continue;
		}

		if (role === "toolResult" && message.toolName === ACP_DELEGATE_TOOL
			&& typeof message.toolCallId === "string") {
			// 派发确认（后台运行，非终态）：只登记 runId 关联
			const runId = extractAcpRunId(extractEntryText(message.content));
			if (runId) entryIdByRunId.set(runId, message.toolCallId);
			continue;
		}

		if (role === "user") {
			const text = extractEntryText(message.content);
			// 终态系统通知是 acp 委托唯一的可靠完成信号（插件保证失败必达）
			const isCompleted = text.startsWith("[acp_delegate completed]");
			const isFailed = text.startsWith("[acp_delegate FAILED");
			if (!isCompleted && !isFailed) continue;
			const runId = extractAcpRunId(text);
			const entryId = runId ? entryIdByRunId.get(runId) : undefined;
			const entry = entryId ? byId.get(entryId) : undefined;
			if (!entry || TERMINAL_STATUSES.has(entry.status)) continue;
			entry.status = isFailed ? "error" : "completed";
			if (Number.isFinite(timestampMs)) entry.completedAt = timestampMs;
			if (isFailed) {
				const excerpt = extractAcpErrorExcerpt(text);
				if (excerpt) entry.error = excerpt;
			}
		}
	}

	return [...byId.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/**
 * 从会话文件原始条目推导 subagent 工具（nicobailon pi-subagents）的子代理条目。
 *
 * 推导单任务派发：args 有 agent、无 action/workflow 字段。前台派发的 toolResult
 * 携带最终报告全文，直接落终态；异步派发回执（含运行时强制后台的派发）把条目
 * 重键为回执中的 asyncId 并保持 running——与 subagent-async widget 的 run.id
 * 同源后，渲染层按 id 合并去重，且派发 args.task 的描述文本可供无 task 文本的
 * widget 条目补充（widget 快照只有 agent 名）。action 管理查询（list/status 等）
 * 与工作流脚本派发不是单次运行，不推导。
 */
export function deriveSubagentToolEntries(
	rawEntries: readonly unknown[],
): PiSubagentEntry[] {
	const byId = new Map<string, PiSubagentEntry>();
	// toolCallId → 条目：派发初始以 toolCallId 为键；异步回执到达后重键为 asyncId。
	// 两张表共享同一 entry 对象，重键时同步增删 byId，byToolCallId 保留原键供后续
	// 同 callId 结果幂等。
	const byToolCallId = new Map<string, PiSubagentEntry>();

	for (const raw of rawEntries) {
		if (!isRecord(raw) || raw.type !== "message" || !isRecord(raw.message)) continue;
		const message = raw.message;
		const timestampMs = typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : NaN;
		const role = typeof message.role === "string" ? message.role : "";

		if (role === "assistant" && Array.isArray(message.content)) {
			for (const item of message.content) {
				if (!isRecord(item) || item.type !== "toolCall" || item.name !== SUBAGENT_TOOL) continue;
				const toolCallId = typeof item.id === "string" ? item.id : "";
				if (!toolCallId || byToolCallId.has(toolCallId)) continue;
				const args = isRecord(item.arguments) ? item.arguments : {};
				// 派发形态：agent 必带；action（管理查询）与 workflowScript*（工作流）不是单次运行
				if (typeof args.agent !== "string" || !args.agent) continue;
				if (args.action != null || args.workflowScript != null || args.workflowScriptPath != null) continue;
				// async:true 显式后台派发也推导：回执到达后重键为 asyncId（见下方 toolResult 分支）
				const entry: PiSubagentEntry = {
					id: toolCallId,
					type: args.agent,
					description: typeof args.task === "string" ? args.task : "",
					status: "running",
					startedAt: Number.isFinite(timestampMs) ? timestampMs : undefined,
					source: "toolcall",
					via: "pi-subagents-tool",
				};
				byToolCallId.set(toolCallId, entry);
				byId.set(toolCallId, entry);
			}
			continue;
		}

		if (role === "toolResult" && message.toolName === SUBAGENT_TOOL
			&& typeof message.toolCallId === "string") {
			const entry = byToolCallId.get(message.toolCallId);
			if (!entry || TERMINAL_STATUSES.has(entry.status)) continue;
			const text = extractEntryText(message.content);
			// 异步派发回执：运行转后台，非最终报告。重键为回执中的 asyncId（与
			// subagent-async widget 的 run.id 同源，渲染层按 id 合并去重），保持
			// running；提取不到 asyncId 的罕见回执（如 external-job follow-up）
			// 保持 toolCallId 键，状态不变，由运行时 widget / 活性降级覆盖。
			if (isAsyncDispatchReceipt(text)) {
				const asyncId = extractAsyncRunId(text);
				if (asyncId && asyncId !== entry.id) {
					byId.delete(entry.id);
					entry.id = asyncId;
					byId.set(asyncId, entry);
				}
				continue;
			}
			// 前台派发的结果即最终报告（与异步回执的「派发确认」语义不同）
			entry.status = message.isError === true ? "error" : "completed";
			if (text) entry.result = text;
			if (Number.isFinite(timestampMs)) entry.completedAt = timestampMs;
		}
	}

	return [...byId.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/**
 * 合并两条工具推导链：acp_delegate 条目 id（acp_delegate_*）与 subagent 工具调用 id
 * （call_xxx）天然不相交，直接拼接后统一按 startedAt 降序。
 */
export function deriveToolSubagentEntries(rawEntries: readonly unknown[]): PiSubagentEntry[] {
	return mergeSubagentSources(
		[],
		[...deriveAcpDelegateEntries(rawEntries), ...deriveSubagentToolEntries(rawEntries)],
	);
}

/**
 * record/锚点（权威）与工具推导条目合并：推导条目 id（acp_delegate_* / call_xxx）
 * 与 pi-subagents 插件的 agent id（UUID）天然不相交，合并只影响推导链自身。
 *
 * 同 id 时默认 record 优先；唯一例外：record 是「stopped 且无任何结果/错误文本」
 * ——即读取侧由残留 start 锚点合成的空壳——而推导条目已从终态信号拿到真实结局时，
 * 推导更准确，以推导为准。
 */
export function mergeSubagentSources(
	records: PiSubagentEntry[],
	derived: PiSubagentEntry[],
): PiSubagentEntry[] {
	const byId = new Map(records.map((record) => [record.id, record]));
	for (const entry of derived) {
		const existing = byId.get(entry.id);
		if (!existing) {
			byId.set(entry.id, entry);
			continue;
		}
		const isBareStoppedShell = existing.status === "stopped"
			&& existing.result == null && existing.error == null;
		if (isBareStoppedShell && TERMINAL_STATUSES.has(entry.status)) {
			byId.set(entry.id, entry);
		}
	}
	return [...byId.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/**
 * 无活 runtime 时清理推导条目残留的 running：终态通知没写进文件（进程被杀/崩溃）
 * 的委托在会话文件里永远是 running，历史会话里会误导为仍在运行。降级为 stopped，
 * 与 start 锚点残留合成 stopped 同语义；活会话保持 running（后续通知/桥接会覆盖）。
 */
export function downgradeStaleRunning(entries: PiSubagentEntry[]): PiSubagentEntry[] {
	let changed = false;
	const next = entries.map((entry) => {
		if (entry.source === "toolcall" && (entry.status === "running" || entry.status === "queued")) {
			changed = true;
			return { ...entry, status: "stopped" as const };
		}
		return entry;
	});
	return changed ? next : entries;
}
