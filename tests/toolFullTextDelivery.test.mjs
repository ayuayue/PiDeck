import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 文本驻留契约：工具结果截断下发 + 「查看完整输出」按需读取链路
const projector = readFileSync("src/main/pi/AgentMessageProjector.ts", "utf8");
const formatToolDetail = readFileSync("src/shared/formatToolDetail.ts", "utf8");
const agentUtils = readFileSync("src/main/pi/agentUtils.ts", "utf8");
const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const reader = readFileSync("src/main/pi/SessionHistoryReader.ts", "utf8");
const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const toolCard = readFileSync("src/renderer/src/components/session/ToolCallComponents.tsx", "utf8");

test("tool detail is delivered with truncated/fullLength markers", () => {
	// detailText 整体截断（拼接后可能超单段上限），并带截断标记供渲染层展示按需加载入口
	assert.match(formatToolDetail, /export function truncateDetailWithMeta\(/);
	assert.match(formatToolDetail, /return \{ text, truncated: false, fullLength: text\.length \};/);
	assert.match(formatToolDetail, /truncated: true,\n\t\tfullLength: text\.length,/);
	assert.match(projector, /truncateDetailWithMeta\(text: string\)/);
	// history 分支写入标记
	assert.match(projector, /detailText: detailDelivery\.text,/);
	assert.match(projector, /\? \{ truncated: true, fullLength: detailDelivery\.fullLength \}/);
});

test("runtime tool path caches full text for on-demand read", () => {
	// 运行期完整结果只进 LRU 缓存（toolFullTextByMessageId），截断版进 meta
	assert.match(agentManager, /private readonly toolFullTextByMessageId = new Map<string, string>\(\);/);
	assert.match(agentManager, /TOOL_FULL_TEXT_LRU_LIMIT = 200/);
	assert.match(agentManager, /if \(detailDelivery\.truncated\)/);
	assert.match(agentManager, /this\.toolFullTextByMessageId\.set\(messageId, fullText\);/);
	// agent 停止时缓存整体释放
	assert.match(agentManager, /toolFullTextByMessageId\.clear\(\);/);
});

test("delivery strips redundant meta.result from tool messages", () => {
	// 下发瘦身：meta.result 与 detailText 重复（渲染层从不读取 result），只在 IPC 边界剥离
	assert.match(agentUtils, /export function stripToolResultForDelivery\(messages: ChatMessage\[\]\)/);
	assert.match(agentUtils, /delete meta\.result;/);
	// 全部下发出口统一剥离：flush 两个分支 + getMessageWindow + disk 分页 facade
	assert.match(agentUtils, /stripToolResultForDelivery\(all\.slice\(dirtyFrom\)\)/);
	assert.match(agentUtils, /stripToolResultForDelivery\(all\.slice\(boundedWindow\)\)/);
	assert.match(agentManager, /stripToolResultForDelivery\(\[\.\.\.summaryCards, \.\.\.all\.slice\(windowStart\)\]\)/);
	assert.match(agentManager, /stripToolResultForDelivery\(page\.messages\)/);
});

test("full text read falls back to session file with LRU cache", () => {
	// 主进程：内存缓存优先，回退会话文件定位读取（不整文件转换）
	assert.match(agentManager, /async readMessageFullText\(/);
	assert.match(agentManager, /this\.toolFullTextByMessageId\.get\(messageId\)/);
	assert.match(agentManager, /this\.sessionHistoryReader\.readMessageFullText\(sessionPath, messageId, entryId\)/);
	// 文件读取：显示索引 + offset 读单行（禁止整文件 split），LRU 200
	assert.match(reader, /async readMessageFullText\(/);
	assert.match(reader, /getSessionDisplayIndex/);
	assert.match(reader, /readIndexedSessionMessages/);
	assert.match(reader, /FULL_TEXT_CACHE_LIMIT = 200/);
});

test("IPC channel, handler and preload surface are wired", () => {
	assert.match(ipc, /sessionsCatalogReadMessageFullText: "sessions:catalog-read-message-full-text"/);
	assert.match(readFileSync("src/main/ipc/sessionIpc.ts", "utf8"), /ipcChannels\.sessionsCatalogReadMessageFullText,/);
	// 四参签名：sessionId 用于运行期绑定不可用时的历史会话文件回退（_viewer 投影）
	// 形参可能被格式化到同一行：用 \s* 容忍。
	assert.match(preload, /readMessageFullText: \(\s*sessionId: string \| undefined,\s*agentId: string,\s*messageId: string,\s*entryId\?: string,?\s*\)/);
	// handler 侧：运行期路径失败时回退 catalog filePath 定位
	// 实参可能被格式化到同一行：\(\s*…\s*\) 容忍。
	assert.match(readFileSync("src/main/ipc/sessionIpc.ts", "utf8"), /readMessageFullTextFromFile\(\s*record\.filePath,\s*messageId,\s*entryId as string \| undefined,?\s*\)/);
});

test("ToolCard shows on-demand full-output entry with loading/error states", () => {
	// 截断标记驱动入口；加载成功替换显示文本，失败保留重试
	assert.match(toolCard, /isTruncated = props\.message\.meta\?\.truncated === true/);
	assert.match(toolCard, /desktopApi\.sessions\.readMessageFullText\(/);
	assert.match(toolCard, /setFullText\(result\.text\)/);
	assert.match(toolCard, /setFullError\(true\)/);
	assert.match(toolCard, /fullOutputLoadFailed/);
});

test("pi-side truncation is surfaced as resultTruncation meta with copyable path", () => {
	// pi 0.99 起 bash/powershell 结果 >1 MiB 由 pi 截断，details.fullOutputPath 是
	// 完整输出所在文件；与展示层 truncated（读会话文件）是两回事，不能混用一个标记。
	assert.match(formatToolDetail, /export function extractPiToolTruncation\(/);
	// 运行期（live）与历史投影两条路径都写 meta.resultTruncation
	assert.match(agentManager, /const piTruncation = extractPiToolTruncation\(result\);/);
	assert.match(agentManager, /\? \{ resultTruncation: piTruncation \}/);
	assert.match(projector, /const piTruncation = extractSharedPiTruncation\(result\);/);
	assert.match(projector, /\? \{ resultTruncation: piTruncation \}/);
	// 渲染层：单独一行展示路径 + 复制按钮（不代读 pi 的截断文件）
	assert.match(toolCard, /resultTruncation as \{ fullOutputPath\?: string \} \| undefined/);
	assert.match(toolCard, /piOutputTruncated/);
	assert.match(toolCard, /copyTextWithCopiedNotice\(piTruncation\.fullOutputPath/);
	// 中英文案同步（含参数占位）
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	assert.match(zh, /"tool\.piOutputTruncated": ".*\{path\}"/);
	assert.match(en, /"tool\.piOutputTruncated": ".*\{path\}"/);
	assert.match(zh, /"tool\.copyPath": "/);
	assert.match(en, /"tool\.copyPath": "/);
});
