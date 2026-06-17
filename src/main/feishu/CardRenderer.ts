/**
 * CardRenderer — RunState → CardKit 2.0 卡片 JSON 的纯函数渲染器
 *
 * 参考 Proma 的 card-renderer-v2.ts：
 * - streaming_mode 标志告诉飞书这是动态卡
 * - 工具调用 >= 3 时合并为摘要面板
 * - 底部 summary 是手机端通知预览的短文本
 * - 可折叠面板展示工具输入输出
 */

import type { Block, FooterStatus, RunState, ToolEntry } from "./CardRunState";

const REASONING_MAX = 1500;
const TEXT_BLOCK_MAX = 20_000;
const MIN_TOOLS_TO_COLLAPSE = 3;
const TOOL_BODY_MAX = 4000;

export interface RenderOptions {
	header?: string;
	stopHint?: string;
	showToolCalls?: boolean;
}

interface ToolGroup { kind: "tools"; tools: ToolEntry[] }
interface TextGroup { kind: "text"; content: string }
type Group = ToolGroup | TextGroup;

export function renderRunCard(state: RunState, opts: RenderOptions = {}): object {
	const showToolCalls = opts.showToolCalls !== false;
	const elements: object[] = [];

	// 思考过程面板
	if (state.reasoning.content) {
		elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
	}

	// 内容块
	const visibleBlocks = showToolCalls
		? state.blocks
		: state.blocks.filter((b) => b.kind !== "tool");

	for (const group of groupBlocks(visibleBlocks)) {
		if (group.kind === "text") {
			if (group.content.trim()) {
				elements.push(markdown(truncate(group.content, TEXT_BLOCK_MAX)));
			}
		} else {
			elements.push(...renderToolGroup(group.tools, state.terminal !== "running"));
		}
	}

	// 终态标记
	if (state.terminal === "interrupted") {
		elements.push(noteMd("_已被中断_"));
	} else if (state.terminal === "error" && state.errorMsg) {
		elements.push(noteMd(`❌ Agent 失败：${state.errorMsg}`));
	} else if (state.terminal === "done" && elements.length === 0) {
		elements.push(noteMd("_（Agent 未返回内容）_"));
	}

	// 运行中：显示 footer + 停止提示
	if (state.terminal === "running") {
		if (state.footer) elements.push(footerStatus(state.footer, state.blocks));
		if (opts.stopHint) elements.push(noteMd(opts.stopHint));
	} else {
		// 完成后：显示耗时等 meta
		elements.push(metaFooter(state));
	}

	const card: Record<string, unknown> = {
		schema: "2.0",
		config: {
			streaming_mode: state.terminal === "running",
			summary: { content: summaryText(state) },
		},
		body: { elements },
	};

	if (opts.header) {
		card.header = {
			title: { tag: "plain_text", content: opts.header },
			template: state.terminal === "error" ? "red" : state.terminal === "running" ? "blue" : "default",
		};
	}

	return card;
}

function* groupBlocks(blocks: Block[]): Generator<Group> {
	let toolBuf: ToolEntry[] = [];
	for (const b of blocks) {
		if (b.kind === "tool") {
			toolBuf.push(b.tool);
		} else {
			if (toolBuf.length > 0) {
				yield { kind: "tools", tools: toolBuf };
				toolBuf = [];
			}
			yield { kind: "text", content: b.content };
		}
	}
	if (toolBuf.length > 0) yield { kind: "tools", tools: toolBuf };
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean): object[] {
	if (tools.length === 0) return [];
	if (tools.length < MIN_TOOLS_TO_COLLAPSE) {
		return tools.map((t) => toolPanel(t));
	}
	if (finalized) {
		return [toolSummaryPanel(tools, true)];
	}
	// 运行期：已完成的合并成摘要，最新的单独
	const prior = tools.slice(0, -1);
	const latest = tools[tools.length - 1];
	const out: object[] = [];
	if (prior.length > 0) out.push(toolSummaryPanel(prior, false));
	if (latest) out.push(toolPanel(latest));
	return out;
}

function reasoningPanel(content: string, active: boolean): object {
	const title = active ? "**🧠 思考中...**" : "**💭 思考完成（点击查看）**";
	return collapsiblePanel({
		title,
		expanded: active,
		border: "grey",
		body: truncate(content, REASONING_MAX),
	});
}

function toolPanel(tool: ToolEntry): object {
	return collapsiblePanel({
		title: toolHeaderText(tool),
		expanded: false,
		border: tool.status === "error" ? "red" : "grey",
		body: toolBodyMd(tool) || "_无输出_",
	});
}

function toolSummaryPanel(tools: ToolEntry[], finalized: boolean): object {
	const suffix = finalized ? "（已结束）" : "";
	const title = `**${tools.length} 个工具调用${suffix}**`;
	const headerList = tools.map((t) => `- ${toolHeaderText(t)}`).join("\n");
	return {
		tag: "collapsible_panel",
		expanded: false,
		header: panelHeader(title),
		border: { color: "blue", corner_radius: "5px" },
		vertical_spacing: "8px",
		padding: "8px 8px 8px 8px",
		elements: [{ tag: "markdown", content: headerList, text_size: "notation" }],
	};
}

function collapsiblePanel(opts: { title: string; expanded: boolean; border: "grey" | "red" | "blue"; body: string }): object {
	return {
		tag: "collapsible_panel",
		expanded: opts.expanded,
		header: panelHeader(opts.title),
		border: { color: opts.border, corner_radius: "5px" },
		vertical_spacing: "8px",
		padding: "8px 8px 8px 8px",
		elements: [{ tag: "markdown", content: opts.body, text_size: "notation" }],
	};
}

function panelHeader(titleMd: string): object {
	return {
		title: { tag: "markdown", content: titleMd },
		vertical_align: "center",
		icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
		icon_position: "follow_text",
		icon_expanded_angle: -180,
	};
}

function markdown(content: string): object {
	return { tag: "markdown", content };
}

function noteMd(content: string): object {
	return { tag: "markdown", content, text_size: "notation" };
}

function footerStatus(status: Exclude<FooterStatus, null>, blocks: Block[]): object {
	if (status === "thinking") return noteMd("🧠 正在思考...");
	if (status === "streaming") return noteMd("✍️ 正在输出...");
	// tool_running
	const runningTool = [...blocks].reverse().find(
		(b) => b.kind === "tool" && b.tool.status === "running",
	);
	if (runningTool && runningTool.kind === "tool") {
		return noteMd(`🔧 正在调用 \`${runningTool.tool.name}\``);
	}
	return noteMd("🔧 正在调用工具...");
}

function metaFooter(state: RunState): object {
	const parts: string[] = [];
	if (state.meta.durationMs !== undefined) {
		parts.push(`⏱ ${(state.meta.durationMs / 1000).toFixed(1)}s`);
	}
	if (state.meta.model) {
		parts.push(state.meta.model);
	}
	return noteMd(parts.length > 0 ? parts.join("  ·  ") : "✅ 已完成");
}

function summaryText(state: RunState): string {
	if (state.terminal === "interrupted") return "已中断";
	if (state.terminal === "error") return "出错";
	if (state.terminal === "done") return "已完成";
	if (state.footer === "tool_running") {
		const runningTool = [...state.blocks].reverse().find(
			(b) => b.kind === "tool" && b.tool.status === "running",
		);
		if (runningTool && runningTool.kind === "tool") return `正在调用 ${runningTool.tool.name}`;
		return "正在调用工具";
	}
	if (state.footer === "streaming") return "正在输出";
	if (state.footer === "thinking") return "思考中";
	return "处理中";
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…（已截断）` : s;
}

function toolHeaderText(tool: ToolEntry): string {
	const icon = tool.status === "error" ? "❌" : tool.status === "done" ? "✅" : "🔄";
	const name = tool.name;
	const summary = toolInputSummary(tool);
	const summaryPart = summary ? ` \`${summary}\`` : "";
	return `${icon} **${name}**${summaryPart}`;
}

function toolInputSummary(tool: ToolEntry): string {
	const input = tool.input;
	if (!input || typeof input !== "object") return "";
	const obj = input as Record<string, unknown>;
	if (typeof obj.command === "string") return clip(obj.command, 80);
	if (typeof obj.file_path === "string") return clip(obj.file_path, 80);
	if (typeof obj.path === "string") return clip(obj.path, 80);
	if (typeof obj.pattern === "string") return clip(obj.pattern, 80);
	return "";
}

function toolBodyMd(tool: ToolEntry): string {
	const parts: string[] = [];
	if (tool.input && typeof tool.input === "object") {
		try {
			const inputStr = JSON.stringify(tool.input, null, 2);
			parts.push("**Input**\n```json\n" + truncate(inputStr, 1500) + "\n```");
		} catch { /* ignore */ }
	}
	if (tool.output) {
		parts.push("**Output**\n```\n" + truncate(tool.output, TOOL_BODY_MAX) + "\n```");
	}
	return parts.join("\n\n");
}

function clip(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max) + "…";
}