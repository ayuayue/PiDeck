import type { ChatMessage } from "../../../shared/types";
import { extractReferenceMessageText } from "../../../shared/sessionReferenceContext";
import { getAppLogger } from "../../logging/sharedLogger";
import { extractMessageText, extractThinkingRaw } from "../../pi/messageContent";
import { scanJsonlLines } from "../jsonlLineStream";

/**
 * 「引用历史会话消息」选择器的回传上限（从最新往前保留）。
 *
 * 条数与字节双上限：正常会话（几百条 / MB 级）不受影响；只有极端大会话会被截断，
 * 避免把上万条消息（含工具结果正文）一次回传渲染层——与 #213 的 IPC 负载问题同源。
 */
const REFERENCE_MESSAGE_LIMIT = 1000;
const REFERENCE_CONTENT_BYTES = 8 * 1024 * 1024;

/** 消息读取需要的宿主持有面：整文件读入口（含体量护栏）与会话文件的宿主路径映射。 */
export type SessionMessageReadHost = {
	/** 整文件读入会话原文（含 MAX_IN_MEMORY_SESSION_BYTES 护栏）。 */
	readSessionRawText(filePath: string): Promise<string>;
	/** 会话文件本体读写用的宿主路径（WSL → UNC 映射）。 */
	hostPathFor(filePath: string): string;
};

/**
 * 读取会话消息列表（「引用历史会话消息」选择器用），支持 WSL 路径。
 *
 * 大会话必须流式读：整文件 `readFile + split` 在数百 MB 会话上会撞 V8 单字符串
 * 上限（ERR_STRING_TOO_LONG）或主进程 384MB 堆上限（V8 abort → 应用闪退）。
 * 返回值再叠一层条数/字节上限（只截尾，保留最近的），见 REFERENCE_MESSAGE_LIMIT。
 *
 * 取文口径是 `extractReferenceMessageText`（**不含 thinking**）：thinking 实测占这类会话
 * 正文的八成以上，进来只会把引用上下文撑爆（见 shared/sessionReferenceContext 文件头）。
 * 这里的条数/字节上限只保护 IPC 负载，真正的上下文预算在 buildSessionReferenceContext。
 */
export async function readSessionMessages(host: SessionMessageReadHost, filePath: string): Promise<Array<{ role: string; content: string; timestamp: number }>> {
	const messages: Array<{ role: string; content: string; timestamp: number }> = [];
	let contentBytes = 0;
	let truncated = false;
	const accept = (line: string): void => {
		try {
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (entry.type && entry.type !== "message") return;
			if (entry.sessionName && !entry.message) return;
			const message = (entry.message ?? (entry.data as Record<string, unknown> | undefined)?.message ?? entry) as Record<string, unknown> | undefined;
			if (!message?.role) return;
			const content = extractReferenceMessageText(message.content).trim();
			if (!content) return;
			if (message.role !== "user" && message.role !== "assistant") return;
			messages.push({ role: String(message.role), content, timestamp: Number(entry.ts ?? entry.timestamp ?? Date.now()) });
			contentBytes += content.length;
			while (messages.length > REFERENCE_MESSAGE_LIMIT || (contentBytes > REFERENCE_CONTENT_BYTES && messages.length > 1)) {
				const dropped = messages.shift();
				contentBytes -= dropped?.content.length ?? 0;
				truncated = true;
			}
		} catch {
			// 单行解析失败跳过；大量失败说明 JSONL 结构异常，双写日志文件便于离线排查
			void getAppLogger()?.warn("session", "Skipped unparseable JSONL line", { filePath });
			console.warn(`[SessionScanner] 跳过无法解析的 JSONL 行: ${filePath}`);
		}
	};
	// WSL 会话经 UNC 走同一条流式扫描（不再 wsl cat 整文件字符串）
	await scanJsonlLines(host.hostPathFor(filePath), (line) => {
		if (line) accept(line);
	});
	if (truncated) {
		void getAppLogger()?.info("session", "Reference message list truncated", {
			filePath,
			kept: messages.length,
			keptBytes: contentBytes,
		});
	}
	return messages;
}

/**
 * 读会话文件并返回与 Agent 运行时完全一致的 ChatMessage[]。
 * 使用与 AgentManager.convertAgentMessages 相同的提取逻辑：
 *  - user 消息：extractMessageText + extractImages
 *  - assistant 消息：extractMessageText + extractThinkingRaw
 *  - toolResult 消息：配对前面的 toolCall 生成工具卡片
 *  - compactionSummary：生成系统消息
 */
export async function readSessionChatMessages(host: SessionMessageReadHost, filePath: string): Promise<ChatMessage[]> {
	const raw = await host.readSessionRawText(filePath);
	const lines = raw.split(/\r?\n/).filter(Boolean);

	// 第一遍：收集所有 toolCall，用于 toolResult 配对
	const toolCallsMap = new Map<string, { name: string; args: unknown }>();
	for (const line of lines) {
		try {
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (entry.type === "message") {
				const msg = entry.message as Record<string, unknown> | undefined;
				if (msg?.role === "assistant" && Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if ((block as Record<string, unknown>)?.type === "toolCall") {
							const tc = block as Record<string, unknown>;
							if (tc.id) {
								toolCallsMap.set(String(tc.id), { name: String(tc.name ?? "tool"), args: tc.arguments });
							}
						}
					}
				}
			}
		} catch {
			/* skip */
		}
	}

	// 第二遍：生成 ChatMessage[]
	const messages: ChatMessage[] = [];
	let seq = 0;

	for (const line of lines) {
		try {
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (entry.type !== "message") continue;
			const msg = entry.message as Record<string, unknown> | undefined;
			if (!msg?.role) continue;
			const ts = Number(entry.timestamp ?? msg.timestamp ?? Date.now());

			if (msg.role === "user") {
				const text = extractMessageText(msg.content);
				if (!text.trim()) continue;
				const images = extractImagesFromContent(msg.content);
				messages.push({
					id: `sv-u-${seq++}`,
					agentId: "_viewer",
					role: "user",
					text,
					timestamp: ts,
					...(images.length > 0 ? { images } : {}),
				});
			} else if (msg.role === "assistant") {
				const images = extractImagesFromContent(msg.content);
				// SessionFileEditor 将 extra 展开到 message 顶层，因此历史 JSONL
				// 实际字段是 message.api / message.imageGen，而不是 message.extra。
				const extraRecord = msg;
				// 旧历史只保存了 openai-images 标识，没有 imageGen 元数据；补齐标记后
				// 才能进入生图结果组件，显示复制/保存操作，而不是普通图片预览。
				const isImageGen = extraRecord.api === "openai-images" || (extraRecord.imageGen && typeof extraRecord.imageGen === "object");
				const text = extractMessageText(msg.content) || (isImageGen ? "[imagegen]" : "");
				if (!text.trim() && images.length === 0) continue;
				const thinking = extractThinkingRaw(msg.content);
				const imageGen = isImageGen ? (extraRecord.imageGen && typeof extraRecord.imageGen === "object" ? extraRecord.imageGen : { status: "complete", prompt: "" }) : undefined;
				messages.push({
					id: `sv-a-${seq++}`,
					agentId: "_viewer",
					role: "assistant",
					text,
					timestamp: ts,
					...(thinking ? { thinking } : {}),
					...(images.length > 0 ? { images } : {}),
					...(imageGen ? { meta: { imageGen } } : {}),
				});
			} else if (msg.role === "toolResult") {
				const toolCallId = String(msg.toolCallId ?? `sv-tool-${seq}`);
				const historicalCall = toolCallsMap.get(toolCallId);
				const toolName = String(msg.toolName ?? historicalCall?.name ?? "tool");
				const isError = Boolean(msg.isError);
				const icon = isError ? "✗" : "✓";
				messages.push({
					id: `sv-t-${seq++}`,
					agentId: "_viewer",
					role: "tool",
					text: `${icon} ${toolName}`,
					timestamp: ts,
					meta: {
						status: isError ? "error" : "done",
						toolName,
						toolCallId,
						isError,
					},
				});
			}
		} catch {
			/* skip malformed lines */
		}
	}

	return messages.filter((m: ChatMessage) => m.text.trim());
}

/** 从 content 数组中提取图片附件 */
function extractImagesFromContent(content: unknown): Array<{ type: "image"; data: string; mimeType: string }> {
	if (!Array.isArray(content)) return [];
	return content.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const typed = item as Record<string, unknown>;
		if (typed.type !== "image") return [];
		const data = typeof typed.data === "string" ? typed.data : "";
		const mimeType = typeof typed.mimeType === "string" ? typed.mimeType : "image/png";
		return data ? [{ type: "image" as const, data, mimeType }] : [];
	});
}
