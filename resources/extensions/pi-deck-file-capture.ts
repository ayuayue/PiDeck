/**
 * PiDeck File Content Capture Extension
 *
 * 在 edit/write 工具执行前捕获原始文件内容，并在工具结果中注入 _piDeckOriginalContent，
 * 使 PiDeck 桌面端（和任何 RPC 客户端）无需异步读取磁盘即可拿到 diff 基准内容。
 *
 * 工作流程：
 * 1. tool_call(edit/write) → 工具尚未执行，从磁盘读取原文件
 * 2. tool_result → 将 originalContent 注入到 details 字段
 * 3. tool_execution_end → 清理内存
 *
 * 数据会通过 ToolResultMessage.details 持久化到 session JSONL，
 * 因此历史会话恢复时也能直接使用，无需扫描前置 read 结果。
 *
 * 安装位置（pi 自动发现）：
 *   ~/.pi/agent/extensions/pi-deck-file-capture.ts
 *
 * @packageDocumentation
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";

interface CapturedContent {
	originalContent: string;
	filePath: string;
}

// Map<toolCallId, CapturedContent> — 一次工具调用的全生命周期
const capturedContent = new Map<string, CapturedContent>();

export default function (pi: ExtensionAPI) {
	// 步骤1：工具执行前，从磁盘捕获原始文件内容
	// 这是唯一能保证文件未被修改的时机。
	pi.on("tool_call", async (event) => {
		const isEdit = isToolCallEventType("edit", event);
		const isWrite = isToolCallEventType("write", event);
		if (!isEdit && !isWrite) return;

		// edit 工具使用 path；write 工具使用 path 或 file_path
		const filePath = event.input.path ?? (event.input as any).file_path ?? "";
		if (!filePath) return;

		// 提前读文件。对新文件（write 创建）readFile 会失败 → originalContent 留空
		let originalContent = "";
		try {
			originalContent = await readFile(filePath, "utf-8");
		} catch {
			// 文件不存在（写新文件），留空即可
		}

		capturedContent.set(event.toolCallId, { originalContent, filePath });
	});

	// 步骤2：工具执行后，将原始内容注入工具结果 details
	// details 字段是 any 类型，会被持久化到 session JSONL 的 ToolResultMessage 中，
	// 因此实时场景和历史会话恢复都能拿到原始内容。
	pi.on("tool_result", async (event) => {
		const stored = capturedContent.get(event.toolCallId);
		if (!stored) return;

		return {
			details: {
				...event.details,
				_piDeckOriginalContent: stored.originalContent,
				_piDeckFilePath: stored.filePath,
			},
		};
	});

	// 步骤3：工具完全结束后清理内存
	pi.on("tool_execution_end", (event) => {
		capturedContent.delete(event.toolCallId);
	});
}
