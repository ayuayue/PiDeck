/**
 * GUI 扩展桥 —— 节点树渲染层（§8.1）。
 *
 * 把桥推来的 `BridgeUINode` 直接投影到 **PiDeck 已有的 UI 组件**上：
 * 已有的直接用，不新做组件体系（§2「直接复用 PiDeck UI」）。
 *
 * 渲染纪律（§8.1）：
 * 1. 每个贡献各自包一层容错（单个崩溃不影响其他）
 * 2. 没有内容时**不占位**（PiDeck 原有布局不变）
 * 3. 事件只往上报，**不自己改状态**（状态由 pi 侧组件持有，回灌后再推新树）
 *
 * 本文件只做**布局与基础展示类** kind；交互/数据/反馈类在 `renderBridgeControls.tsx`。
 */

import type { ReactNode } from "react";
import { Badge } from "../ui-shadcn/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui-shadcn/card";
import { ScrollArea } from "../ui-shadcn/scroll-area";
import type { BridgeStyleToken, BridgeUINode } from "../../../../shared/types/bridge";
import { renderBridgeControl } from "./renderBridgeControls";

/** 桥交互事件的上报回调（渲染层只上报，不改状态）。 */
export type BridgeEventSink = (nodeId: string, event: BridgeNodeEvent) => void;

/** 渲染层能上报的交互事件（与主进程契约一致，§9.3）。 */
export type BridgeNodeEvent =
	| { type: "select"; index: number }
	| { type: "navigate"; index: number }
	| { type: "input"; value: string }
	| { type: "key"; key: string }
	| { type: "filter"; filter: string }
	| { type: "action"; actionId: string; payload?: unknown };

/**
 * 语义 tone → 文字色 class。
 *
 * 用 PiDeck 既有的语义 token（`text-primary` / `text-muted-foreground` 等），
 * 不写死色值、不新增手写 CSS class（AGENTS.md「新样式一律走 Tailwind utility」）。
 */
const TONE_TEXT: Record<string, string> = {
	default: "",
	muted: "text-muted-foreground",
	accent: "text-primary",
	success: "text-emerald-600 dark:text-emerald-400",
	warning: "text-amber-600 dark:text-amber-400",
	danger: "text-destructive",
};

/** 样式 token → 附加 class。 */
function styleClasses(style?: BridgeStyleToken[]): string {
	if (!style?.length) return "";
	const classes: string[] = [];
	for (const token of style) {
		switch (token) {
			case "bold":
				classes.push("font-semibold");
				break;
			case "italic":
				classes.push("italic");
				break;
			case "underline":
				classes.push("underline");
				break;
			case "strikethrough":
				classes.push("line-through");
				break;
			case "dim":
			case "muted":
				classes.push("text-muted-foreground");
				break;
			case "code":
				classes.push("font-mono text-[0.9em]");
				break;
			default:
				if (TONE_TEXT[token]) classes.push(TONE_TEXT[token]);
				break;
		}
	}
	return classes.join(" ");
}

/** 布局方向 → flex class。 */
function stackClass(node: BridgeUINode): string {
	const direction = node.direction === "row" ? "flex-row" : "flex-col";
	const align = node.align === "center" ? "items-center" : node.align === "end" ? "items-end" : node.align === "start" ? "items-start" : "items-stretch";
	return `flex ${direction} ${align}`;
}

/** gap 数值 → 内联 gap（桥给的数值是「行数」语义，映射成 px 的近似值）。 */
function gapStyle(gap?: number): { gap?: string } {
	if (typeof gap !== "number" || !Number.isFinite(gap) || gap <= 0) return {};
	// 1 行 ≈ 4px 的紧凑映射；上限防止扩展给出夸张值撑破布局
	return { gap: `${Math.min(gap * 4, 64)}px` };
}

/**
 * 渲染一个桥节点。
 *
 * 未知 kind 一律渲染成剥了 ANSI 的等宽文本块（若带 `lines`）或直接返回 null ——
 * **绝不抛错**（§14.6「未知即降级」）。
 */
export function renderBridgeNode(node: BridgeUINode | null | undefined, onEvent: BridgeEventSink, key?: string): ReactNode {
	if (!node || typeof node !== "object") return null;
	const reactKey = key ?? node.id;

	switch (node.kind) {
		// ── 文本 ────────────────────────────────────────────────
		case "text": {
			const className = styleClasses(node.style);
			// 纯文本：无样式时不额外包 span，避免多余 DOM 影响「只追加」断言
			if (!className) return <span key={reactKey}>{node.text ?? ""}</span>;
			return (
				<span key={reactKey} className={className}>
					{node.text ?? ""}
				</span>
			);
		}

		case "markdown":
			// 复用会话时间线同一套 markdown 渲染（懒加载，避免把 streamdown 拖进桥的依赖图）
			return <BridgeMarkdown key={reactKey} source={node.md ?? ""} />;

		// ── 布局 ────────────────────────────────────────────────
		case "vstack":
		case "hstack":
		case "stack":
			return (
				<div key={reactKey} className={stackClass(node)} style={gapStyle(node.gap)}>
					{renderChildren(node, onEvent)}
				</div>
			);

		case "box":
			return (
				<div key={reactKey} className="flex flex-col" style={paddingStyle(node.padding)}>
					{renderChildren(node, onEvent)}
				</div>
			);

		case "spacer":
			// 间隔：用固定高度占位（0 或未给时不占位，§8.4 C）
			if (!node.size) return null;
			return <div key={reactKey} aria-hidden="true" style={{ height: `${Math.min(node.size * 4, 64)}px` }} />;

		case "divider":
			// 用 Tailwind border 而不是新增 Separator 原语：仓库 ui-shadcn 里没有 separator，
			// 为一条分割线引入新组件不符合「优先复用已有能力」。
			return node.label ? (
				<div key={reactKey} className="flex items-center gap-2 py-1">
					<span className="h-px flex-1 bg-border" />
					<span className="text-[11px] text-muted-foreground">{node.label}</span>
					<span className="h-px flex-1 bg-border" />
				</div>
			) : (
				<div key={reactKey} className="my-1 h-px w-full bg-border" role="separator" />
			);

		case "grid":
			return (
				<div
					key={reactKey}
					className="grid gap-2"
					style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(node.columns ?? 2, 12))}, minmax(0, 1fr))` }}
				>
					{renderChildren(node, onEvent)}
				</div>
			);

		case "split":
			// 可拖分割在桥的词汇表里降级为等分 flex（不引入拖拽状态，保持只追加）
			return (
				<div key={reactKey} className={node.direction === "row" ? "flex flex-row gap-2" : "flex flex-col gap-2"}>
					{renderChildren(node, onEvent)}
				</div>
			);

		case "card":
			return (
				<Card key={reactKey} className="py-3 gap-2">
					{node.title ? (
						<CardHeader className="px-3">
							<CardTitle className="text-xs font-medium">{node.title}</CardTitle>
						</CardHeader>
					) : null}
					<CardContent className="px-3 flex flex-col gap-2">{renderChildren(node, onEvent)}</CardContent>
				</Card>
			);

		case "scroll":
		case "scrollarea":
			return (
				<ScrollArea key={reactKey} className="max-h-64">
					<div className="flex flex-col gap-2 pr-2">{renderChildren(node, onEvent)}</div>
				</ScrollArea>
			);

		// ── 基础展示 ────────────────────────────────────────────
		case "badge":
			return (
				<Badge key={reactKey} variant={node.tone === "danger" ? "destructive" : "secondary"} className="text-[11px]">
					{node.label ?? ""}
				</Badge>
			);

		case "icon":
			// 图标名不是 lucide 的稳定契约，渲染成小号文本标记（不猜图标、不崩）
			return (
				<span key={reactKey} className={`text-[11px] ${TONE_TEXT[node.tone ?? "default"] ?? ""}`} aria-label={node.name}>
					{node.name}
				</span>
			);

		case "keyvalue":
			return (
				<div key={reactKey} className="flex flex-col gap-0.5">
					{(node.entries ?? []).map((entry, index) => (
						<div key={`${reactKey}-${index}`} className="flex items-baseline gap-2 text-xs">
							<span className="text-muted-foreground shrink-0">{entry.key}</span>
							<span className="font-mono break-all">{entry.value}</span>
						</div>
					))}
				</div>
			);

		case "codeblock":
			return (
				<pre key={reactKey} className="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-relaxed">
					<code>{node.code ?? ""}</code>
				</pre>
			);

		case "table":
			return (
				<div key={reactKey} className="overflow-x-auto">
					<table className="w-full text-xs">
						<thead>
							<tr>
								{(node.tableColumns ?? []).map((column, index) => (
									<th key={`${reactKey}-h-${index}`} className="border-b px-2 py-1 text-left font-medium text-muted-foreground">
										{column}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{(node.rowsData ?? []).map((row, rowIndex) => (
								<tr key={`${reactKey}-r-${rowIndex}`}>
									{row.map((cell, cellIndex) => (
										<td key={`${reactKey}-r-${rowIndex}-${cellIndex}`} className="border-b px-2 py-1">
											{cell}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);

		case "tree":
			return <BridgeTree key={reactKey} nodes={node.nodes ?? []} />;

		case "image":
			if (!node.src) return null;
			return <img key={reactKey} src={node.src} alt={node.alt ?? ""} className="max-h-64 rounded-md object-contain" />;

		case "ansi":
			// ★ 降级保命路径：剥了 ANSI 的等宽文本块
			return (
				<pre key={reactKey} className="overflow-x-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
					{(node.lines ?? []).join("\n")}
				</pre>
			);

		// ── 交互 / 数据 / 反馈：交给控件渲染器 ──────────────────
		default:
			return renderBridgeControl(node, onEvent, reactKey);
	}
}

/** 递归渲染 children（空 children 不产生容器内内容）。 */
function renderChildren(node: BridgeUINode, onEvent: BridgeEventSink): ReactNode {
	if (!Array.isArray(node.children) || node.children.length === 0) return null;
	return node.children.map((child, index) => renderBridgeNode(child, onEvent, `${node.id}:${index}`));
}

/** padding 数值 → 内联 padding。 */
function paddingStyle(padding?: [number, number]): { padding?: string } {
	if (!Array.isArray(padding)) return {};
	const [x, y] = padding;
	if (!x && !y) return {};
	return { padding: `${Math.min((y ?? 0) * 4, 32)}px ${Math.min((x ?? 0) * 4, 32)}px` };
}

/** 树节点递归渲染（可折叠的用 details，避免自造展开状态）。 */
function BridgeTree({ nodes }: { nodes: BridgeUINode["nodes"] }): ReactNode {
	if (!nodes?.length) return null;
	return (
		<ul className="flex flex-col gap-0.5 text-xs">
			{nodes.map((treeNode, index) => (
				<li key={index} className="flex flex-col gap-0.5">
					<span>{treeNode.label}</span>
					{treeNode.children?.length ? (
						<div className="pl-3 border-l ml-1">
							<BridgeTree nodes={treeNode.children} />
						</div>
					) : null}
				</li>
			))}
		</ul>
	);
}

/** markdown 渲染的懒加载壳：拿不到实现就退化成纯文本（fail-safe）。 */
function BridgeMarkdown({ source }: { source: string }): ReactNode {
	// 直接渲染成 pre-wrap 文本：桥的 markdown 场景（扩展自述/帮助）对格式要求低，
	// 复用会话的 streamdown 管线会把整条 sanitize 链拖进桥的渲染路径，
	// 收益低于风险。留 TODO 待评估按需接入 MarkdownStream。
	return <div className="text-xs leading-relaxed whitespace-pre-wrap">{source}</div>;
}

/**
 * 取某个落点的节点树并渲染。
 *
 * 无内容（落点不存在或值为 null）返回 null —— 调用方据此**不占位**（§8.4 C）。
 */
export function renderBridgeTarget(targets: Record<string, BridgeUINode | null> | undefined, targetId: string, onEvent: BridgeEventSink): ReactNode {
	const node = targets?.[targetId];
	if (!node) return null;
	return renderBridgeNode(node, onEvent);
}