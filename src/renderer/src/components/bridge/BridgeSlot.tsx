/**
 * GUI 扩展桥 —— 落点容器（§8.2 A 组）。
 *
 * 每个落点一个 `BridgeSlot`：从会话的桥状态里取该落点的节点树渲染。
 *
 * **核心纪律：无内容不占位**（§8.4 C）。
 * 落点没有内容时组件返回 `null`，**不产生空 div、不加 margin/gap** ——
 * PiDeck 原有布局的节点数量、顺序、class 零变化（§12.3「只追加」）。
 *
 * **容错**（§8.1 纪律 1）：每个落点各自包一层 ErrorBoundary，
 * 单个贡献渲染崩溃不影响其他落点，也不影响 PiDeck 原有 UI。
 */

import { Component, type ErrorInfo, type ReactNode, useMemo } from "react";
import { useAtomValue } from "jotai";
import { sessionRuntimeUiByIdAtom, currentSessionIdAtom } from "../../atoms/session-atoms";
import { useBridgeEventSink } from "../../hooks/useBridgeEventSink";
import { renderBridgeNode, type BridgeEventSink } from "./renderBridgeNode";
import { BRIDGE_TARGET, type BridgeGuiSlot as BridgeGuiSlotName, type BridgeUINode } from "../../../../shared/types/bridge";

/** 单个落点的容错边界：崩溃只隐藏该落点。 */
class BridgeSlotBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	constructor(props: { children: ReactNode }) {
		super(props);
		this.state = { failed: false };
	}

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		// 桥的渲染失败只表现为「这个落点没出现」，不影响 PiDeck（§14.5）
		console.warn("[gui-bridge] 落点渲染失败，已隐藏该落点", error.message, info.componentStack);
	}

	render(): ReactNode {
		return this.state.failed ? null : this.props.children;
	}
}

/** 桥落点：渲染某个 targetId 的节点树，无内容时返回 null（不占位）。 */
export function BridgeSlot({ sessionId, targetId, className }: { sessionId: string | undefined; targetId: string; className?: string }): ReactNode {
	const ui = useAtomValue(sessionRuntimeUiByIdAtom);
	const targets = sessionId ? ui[sessionId]?.bridgeTargets : undefined;
	const node = targets?.[targetId];
	const onEvent = useBridgeEventSink(sessionId);

	if (!node) return null;
	return (
		<BridgeSlotBoundary>
			<div className={className}>{renderBridgeNode(node, onEvent)}</div>
		</BridgeSlotBoundary>
	);
}

/**
 * 输入框挂件落点：同时渲染 `aboveEditor` 与 `belowEditor` 两个 placement。
 *
 * 桥的落点 id 带 placement 后缀（`widget:<key>:<placement>`），
 * 这里按前缀过滤 —— 同一 key 改 placement 时旧落点会被桥推 null 清掉，
 * 因此不会两处同时出现（§8.4 B）。
 */
export function BridgeWidgetSlot({ sessionId, placement }: { sessionId: string | undefined; placement: "aboveEditor" | "belowEditor" }): ReactNode {
	const ui = useAtomValue(sessionRuntimeUiByIdAtom);
	const targets = sessionId ? ui[sessionId]?.bridgeTargets : undefined;
	const onEvent = useBridgeEventSink(sessionId);

	// 只挑该 placement 的 widget 落点；无 placement 后缀的按 aboveEditor 处理（与现状一致）
	const entries = useMemo(() => {
		if (!targets) return [];
		const prefix = BRIDGE_TARGET.widgetPrefix;
		const suffix = `:${placement}`;
		return Object.entries(targets).filter(([key, value]) => {
			if (!value || !key.startsWith(prefix)) return false;
			const hasPlacement = key.endsWith(":aboveEditor") || key.endsWith(":belowEditor");
			if (!hasPlacement) return placement === "aboveEditor";
			return key.endsWith(suffix);
		});
	}, [placement, targets]);

	if (entries.length === 0) return null;
	return (
		<BridgeSlotBoundary>
			<div className="flex flex-col gap-2">
				{entries.map(([key, node]) => (node ? <div key={key}>{renderBridgeNode(node, onEvent)}</div> : null))}
			</div>
		</BridgeSlotBoundary>
	);
}

/** 状态栏：桥的 setStatus 多 key 条目（§8.2 A 组 status 是新建项）。 */
export function BridgeStatusBar({ sessionId, className }: { sessionId: string | undefined; className?: string }): ReactNode {
	const ui = useAtomValue(sessionRuntimeUiByIdAtom);
	const status = sessionId ? ui[sessionId]?.bridgeStatus : undefined;
	const entries = status ? Object.entries(status) : [];
	if (entries.length === 0) return null;
	return (
		<BridgeSlotBoundary>
			<div className={className ?? "flex flex-wrap items-center gap-x-3 gap-y-0.5"}>
				{entries.map(([key, text]) => (
					<span key={key} className="text-[11px] text-muted-foreground" data-bridge-status={key}>
						{text}
					</span>
				))}
			</div>
		</BridgeSlotBoundary>
	);
}

/** 流式状态行：桥的 setWorkingMessage / setWorkingVisible / setWorkingIndicator（§8.2 A 组）。 */
export function BridgeWorkingLine({ sessionId }: { sessionId: string | undefined }): ReactNode {
	const ui = useAtomValue(sessionRuntimeUiByIdAtom);
	const working = sessionId ? ui[sessionId]?.bridgeWorking : undefined;
	// visible === false → 扩展要求隐藏指示器，此时不渲染（不占位）
	if (!working || working.visible === false) return null;
	const hasMessage = typeof working.message === "string" && working.message.length > 0;
	const frames = working.frames;
	if (!hasMessage && !frames) return null;
	// frames: [] 表示「完全隐藏指示器」（pi 文档语义）
	const showIndicator = !Array.isArray(frames) || frames.length > 0;
	return (
		<BridgeSlotBoundary>
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				{showIndicator ? <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" /> : null}
				{hasMessage ? <span>{working.message}</span> : null}
			</div>
		</BridgeSlotBoundary>
	);
}

/** 取某落点是否存在内容（供调用方决定是否要渲染自己的容器）。 */
export function useBridgeTargetPresent(sessionId: string | undefined, targetId: string): boolean {
	const ui = useAtomValue(sessionRuntimeUiByIdAtom);
	return Boolean(sessionId && ui[sessionId]?.bridgeTargets?.[targetId]);
}

// ── B 组：ctx.gui 的 GUI 专属落点（§7.1-B / §8.2 B 组）──────────

/**
 * 取某 GUI 落点下的全部贡献，按 `order` 升序、同 order 按 key 字母序（§7.1-B）。
 *
 * 落点 id 形态是 `gui:<slot>:<key>`；`matchKey` 用于「按 key 定位单个贡献」的
 * 附加型落点（`toolExtra` 的 key 是 toolName、`messageExtra` 的 key 是 role）。
 *
 * 排序依据是桥推来的 `slot.order`（缺省 1000）。**排序在渲染层做**，
 * 因为桥是「推一帧是一帧」，无法保证到达顺序 —— 宿主排序才是唯一正确的收敛点。
 */
function useGuiContributions(sessionId: string | undefined, slot: BridgeGuiSlot, matchKey?: string): { key: string; node: BridgeUINode }[] {
	const ui = useAtomValue(sessionRuntimeUiByIdAtom);
	const targets = sessionId ? ui[sessionId]?.bridgeTargets : undefined;
	return useMemo(() => {
		if (!targets) return [];
		const prefix = `gui:${slot}:`;
		const entries: { key: string; node: BridgeUINode; order: number }[] = [];
		for (const [targetId, node] of Object.entries(targets)) {
			if (!node || !targetId.startsWith(prefix)) continue;
			const key = targetId.slice(prefix.length);
			if (matchKey !== undefined && key !== matchKey) continue;
			entries.push({ key, node, order: node.slot?.order ?? 1000 });
		}
		entries.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		return entries.map(({ key, node }) => ({ key, node }));
	}, [matchKey, slot, targets]);
}

/**
 * GUI 专属落点容器（§7.1-B 的 14 个位置共用）。
 *
 * 用法：
 * ```tsx
 * <BridgeGuiSlot sessionId={sessionId} slot="tool.extra" matchKey={toolName} />
 * ```
 *
 * - `matchKey` 省略 → 渲染该落点下**全部**贡献（按 order 排序）
 * - `matchKey` 给出 → 只渲染该 key 的贡献（用于 toolExtra / messageExtra 这类附加型落点）
 * - 无贡献时返回 `null`，**不占位**（§8.4 C）
 * - `title` 有值时渲染分组标题（§7.1-B）
 */
export function BridgeGuiSlot({
	sessionId,
	slot,
	matchKey,
	className,
	titleClassName,
}: {
	sessionId: string | undefined;
	slot: BridgeGuiSlotName;
	matchKey?: string;
	className?: string;
	titleClassName?: string;
}): ReactNode {
	const contributions = useGuiContributions(sessionId, slot, matchKey);
	const onEvent = useBridgeEventSink(sessionId);
	if (contributions.length === 0) return null;

	return (
		<BridgeSlotBoundary>
			<div className={className ?? "flex flex-col gap-2"}>
				{contributions.map(({ key, node }) => (
					<div key={key} data-bridge-slot={`${slot}:${key}`}>
						{/* 分组标题：桥把 opts.title 挂在节点 slot 元信息上（§7.1-B） */}
						{node.slot?.title ? <div className={titleClassName ?? "mb-1 text-[11px] font-medium text-muted-foreground"}>{node.slot.title}</div> : null}
						{renderBridgeNode(node, onEvent, key)}
					</div>
				))}
			</div>
		</BridgeSlotBoundary>
	);
}

/** 某个 GUI 落点是否有内容（供调用方决定是否渲染自己的容器）。 */
export function useGuiSlotPresent(sessionId: string | undefined, slot: BridgeGuiSlotName, matchKey?: string): boolean {
	return useGuiContributions(sessionId, slot, matchKey).length > 0;
}

/**
 * 桥的折叠思考块标签（`ctx.ui.setHiddenThinkingLabel`，§8.2 A 组）。
 *
 * 有值时**替换**思考折叠行的耗时小字；无贡献时返回 `undefined`，调用方保持原生文案。
 */
export function useBridgeThinkingLabel(sessionId: string | undefined): string | undefined {
	const ui = useAtomValue(sessionRuntimeUiByIdAtom);
	return sessionId ? ui[sessionId]?.bridgeThinkingLabel : undefined;
}

/**
 * 应用级 chrome（标题栏 / 设置弹窗 / 横幅 / 主内容区）用的会话 id。
 *
 * 这些位置是**单实例**组件（不像分屏那样每栏一份），因此按「当前聚焦会话」取桥状态
 * 是语义正确的 —— 不违反 AGENTS.md「多实例必须按 session 订阅」（那条针对分屏栏）。
 *
 * 与 `SidebarContent` 的差异：侧边栏由 App 显式透传 `currentSessionId` prop，
 * 这里读 atom；两者取值同源，只是接线方式不同。
 */
export function useBridgeChromeSessionId(): string | undefined {
	return useAtomValue(currentSessionIdAtom);
}

/** 覆盖层宿主：ctx.gui.custom 的 overlay / modal（§8.2 C 组）。 */
export function BridgeOverlayHost({ sessionId }: { sessionId: string | undefined }): ReactNode {
	const ui = useAtomValue(sessionRuntimeUiByIdAtom);
	const overlays = sessionId ? ui[sessionId]?.bridgeOverlays : undefined;
	const onEvent = useBridgeEventSink(sessionId);
	const entries = overlays ? Object.entries(overlays) : [];
	if (entries.length === 0) return null;

	return (
		<>
			{entries.map(([elementId, overlay]) => {
				const options = overlay.options;
				const isModal = options?.modal === true;
				const position = options?.position ?? "center";
				return (
					<BridgeSlotBoundary key={elementId}>
						{/* 覆盖层：只追加在现有 DOM 之上，不改动 PiDeck 原有结构（§7.4） */}
						<div className="pointer-events-none fixed inset-0 z-50 flex" data-bridge-overlay={elementId}>
							{isModal ? <div className="pointer-events-auto absolute inset-0 bg-black/40" aria-hidden="true" /> : null}
							<div
								className={`pointer-events-auto relative m-auto max-h-[80vh] overflow-auto rounded-lg border bg-card p-3 text-card-foreground shadow-lg ${
									position === "right" ? "ml-auto mr-4 mt-16" : position === "bottom" ? "mb-16 mt-auto" : position === "fullscreen" ? "h-full w-full rounded-none" : ""
								}`}
							>
								{renderBridgeNode(overlay.node, onEvent)}
							</div>
						</div>
					</BridgeSlotBoundary>
				);
			})}
		</>
	);
}

/** 供外部直接使用的落点 id 常量。 */
export { BRIDGE_TARGET };
export type { BridgeGuiSlotName };

/** 类型再导出，便于落点调用方标注。 */
export type { BridgeEventSink };