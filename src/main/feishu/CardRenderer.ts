/**
 * CardRenderer v4 — RunState → 飞书 interactive 卡片 JSON
 *
 * v4 设计原则：
 * - hr 分割线切分每个区域，层级清晰如 MD 标题
 * - 思考过程用 note 小字，和输出正文区分开
 * - 轨迹一行一条，紧凑整洁
 * - 工具调用带参数预览
 *
 * 配合 CardStream v2 的 im.v1.message.patch 实现真正流式。
 */

import type { Block, RunState, ToolEntry, TrailEntry } from "./CardRunState";

const OUTPUT_MAX = 15_000;
const THINKING_MAX = 2_000;
const TRAIL_ENTRIES_MAX = 20;

export interface RenderOptions {
	header?: string;
	stopHint?: string;
}

export function renderRunCard(state: RunState, opts: RenderOptions = {}): object {
	const elements: object[] = [];
	const isRunning = state.terminal === "running";

	// ── 1. 活动轨迹 ──
	elements.push(renderTrail(state.trail, isRunning));

	// ── 2. 思考过程（note 小字，和输出区分） ──
	if (state.reasoning.content) {
		if (elements.length > 0) elements.push(hr());
		elements.push(renderThinking(state.reasoning.content, state.reasoning.active));
	}

	// ── 3. 当前正在执行的操作 ──
	const runningTools = state.blocks.filter(
		(b) => b.kind === "tool" && b.tool.status === "running",
	);
	for (const b of runningTools) {
		if (b.kind === "tool") {
			if (needsSep(elements)) elements.push(hr());
			elements.push(renderRunningTool(b.tool));
		}
	}

	// ── 4. 输出正文 ──
	if (state.outputText.trim()) {
		if (needsSep(elements)) elements.push(hr());
		elements.push(renderOutput(state.outputText, isRunning));
	}

	// ── 5. 已完成的工具 ──
	const doneTools = state.blocks.filter(
		(b) => b.kind === "tool" && b.tool.status !== "running",
	);
	if (doneTools.length > 0) {
		if (needsSep(elements)) elements.push(hr());
		elements.push(renderDoneTools(doneTools));
	}

	// ── 6. 终态提示 ──
	if (state.terminal === "interrupted") {
		elements.push(hr());
		elements.push(note("⏹ 已被中断"));
	} else if (state.terminal === "error" && state.errorMsg) {
		elements.push(hr());
		elements.push(note(`❌ 失败: ${state.errorMsg}`));
	}

	// ── 7. 底部状态栏 ──
	elements.push(hr());
	elements.push(renderFooter(state, isRunning, opts.stopHint));

	const card: Record<string, unknown> = {
		config: { wide_screen_mode: true, update_multi: true },
		elements,
	};

	if (opts.header) {
		card.header = {
			title: { tag: "plain_text", content: opts.header },
			template: state.terminal === "error" ? "red"
				: state.terminal === "interrupted" ? "grey"
				: state.terminal === "done" ? "green"
				: "blue",
		};
	}

	return card;
}

// ========== 区域渲染 ==========

/** 活动轨迹 — 一行一条，紧凑 */
function renderTrail(trail: TrailEntry[], isRunning: boolean): object {
	let entries = trail;
	let hidden = 0;
	if (entries.length > TRAIL_ENTRIES_MAX) {
		hidden = entries.length - TRAIL_ENTRIES_MAX;
		entries = entries.slice(-TRAIL_ENTRIES_MAX);
	}

	const lines: string[] = [];
	lines.push("**📋 活动轨迹**");

	if (entries.length === 0) {
		lines.push(isRunning ? "_等待 Agent 启动..._" : "_无记录_");
	} else {
		if (hidden > 0) lines.push(`_…前面 ${hidden} 条_`);
		for (const e of entries) {
			const time = fmt(e.timestamp);
			const icon = e.status === "running" ? "🔄" : e.status === "error" ? "❌" : "✅";
			let line = `\`${time}\` ${icon} ${e.text}`;
			if (e.detail) line += ` — ${e.detail}`;
			lines.push(line);
		}
	}

	return md(lines.join("\n"));
}

/** 思考过程 — notation 小字，和正文区分层级 */
function renderThinking(content: string, active: boolean): object {
	const display = content.length > THINKING_MAX
		? content.slice(0, THINKING_MAX) + "\n\n…（已截断）"
		: content;

	const title = active ? "**💭 思考中**" : "**💭 思考过程**";
	return { tag: "markdown", content: `${title}\n${display}`, text_size: "notation" };
}

/** 正在运行的工具 */
function renderRunningTool(tool: ToolEntry): object {
	const preview = toolInputPreview(tool);
	const lines: string[] = [];
	lines.push(`**🔧 正在调用 \`${tool.name}\``);
	if (preview) lines.push(`\`${preview}\``);
	return md(lines.join("\n"));
}

/** 输出正文 */
function renderOutput(text: string, streaming: boolean): object {
	const display = text.length > OUTPUT_MAX
		? text.slice(0, OUTPUT_MAX) + "\n\n…（已截断）"
		: text;
	const marker = streaming ? " 🔵" : "";
	return md(`**📤 输出**${marker}\n\n${display}`);
}

/** 已完成的工具列表 */
function renderDoneTools(blocks: Block[]): object {
	const tools = blocks
		.filter((b) => b.kind === "tool")
		.map((b) => (b as { kind: "tool"; tool: ToolEntry }).tool);

	const MAX = 8;
	let hidden = 0;
	let shown = tools;
	if (tools.length > MAX) {
		hidden = tools.length - MAX;
		shown = tools.slice(0, MAX);
	}

	const lines: string[] = ["**🔧 已完成工具**"];
	for (const t of shown) {
		const icon = t.status === "error" ? "❌" : "✅";
		const preview = toolInputPreview(t);
		const previewPart = preview ? ` — \`${preview}\`` : "";
		lines.push(`${icon} **${t.name}**${previewPart}`);
	}
	if (hidden > 0) lines.push(`_…还有 ${hidden} 个_`);

	return md(lines.join("\n"));
}

/** 底部状态栏 */
function renderFooter(state: RunState, isRunning: boolean, stopHint?: string): object {
	const parts: string[] = [];

	if (isRunning) {
		// 运行中：显示当前阶段
		if (state.footer === "thinking") {
			parts.push("🧠 思考中");
		} else if (state.footer === "tool_running") {
			const rt = [...state.blocks].reverse().find(
				(b) => b.kind === "tool" && b.tool.status === "running",
			);
			if (rt?.kind === "tool") parts.push(`🔧 调用 \`${rt.tool.name}\``);
			else parts.push("🔧 调用工具");
		} else if (state.footer === "streaming") {
			parts.push("✍️ 输出中");
		} else {
			parts.push("⏳ 处理中");
		}

		if (stopHint) parts.push(stopHint);
	} else {
		// 完成：显示耗时
		if (state.meta.durationMs !== undefined) {
			parts.push(`⏱ ${(state.meta.durationMs / 1000).toFixed(1)}s`);
		}
		parts.push("✅ 完成");
	}

	return note(parts.join("  |  "));
}

// ========== 工具函数 ==========

function md(content: string): object {
	return { tag: "markdown", content };
}

function note(content: string): object {
	return { tag: "note", elements: [{ tag: "plain_text", content }] };
}

function hr(): object {
	return { tag: "hr" };
}

/** 最后一个元素不是 hr 才需要分割线 */
function needsSep(elements: object[]): boolean {
	if (elements.length === 0) return false;
	const last = elements[elements.length - 1] as Record<string, unknown>;
	return last.tag !== "hr";
}

function toolInputPreview(tool: ToolEntry): string {
	const input = tool.input;
	if (!input || typeof input !== "object") return "";
	const obj = input as Record<string, unknown>;
	if (tool.name === "read" && typeof obj.filePath === "string") return clip(obj.filePath, 80);
	if (tool.name === "bash" && typeof obj.command === "string") return clip(obj.command, 80);
	if (tool.name === "write" && typeof obj.filePath === "string") return clip(obj.filePath, 80);
	if (tool.name === "edit" && typeof obj.filePath === "string") return clip(obj.filePath, 80);
	if (tool.name === "grep" && typeof obj.pattern === "string") return clip(obj.pattern, 80);
	if (typeof obj.command === "string") return clip(obj.command, 80);
	if (typeof obj.file_path === "string") return clip(obj.file_path, 80);
	if (typeof obj.path === "string") return clip(obj.path, 80);
	if (typeof obj.pattern === "string") return clip(obj.pattern, 80);
	return "";
}

function fmt(ts: number): string {
	const d = new Date(ts);
	return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function p2(n: number): string {
	return n.toString().padStart(2, "0");
}

function clip(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max) + "…";
}
