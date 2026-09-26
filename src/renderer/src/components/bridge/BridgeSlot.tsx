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
import { currentSessionIdAtom, sessionBridgeUiFamily, type SessionRuntimeUiState } from "../../atoms/session-atoms";
import { sessionRuntimeUiBySessionIdAtomFamily } from "../../atoms/session-selectors";
import { useBridgeEventSink } from "../../hooks/useBridgeEventSink";
import { useBridgeResync } from "../../hooks/useBridgeResync";
import { renderBridgeNode, type BridgeEventSink } from "./renderBridgeNode";
import { BRIDGE_TARGET, type BridgeGuiSlot as BridgeGuiSlotName, type BridgeUINode } from "../../../../shared/types/bridge";

/**
 * 没有 sessionId 时用的哨兵 family key。
 *
 * 订阅必须**无条件**发生在 hook 顶层（React 规则），所以无会话时也得取一个 family 实例；
 * 哨兵 key 读到的就是 `undefined`，语义与「没有会话」一致，且不会撞真实 sessionId。
 */
const NO_SESSION_FAMILY_KEY = "__bridge_no_session__";

/**
 * 订「本会话」的桥落点表（§8.2 A 组）。
 *
 * 直接订 `sessionRuntimeUiByIdAtom` 会让**任一**会话推帧时全部分屏栏的所有落点一起重渲
 * （PR 评审 §2.3 的多实例订阅违规）；这里按 sessionId 订 family，`selectAtom(Object.is)`
 * 保证别的会话推帧时本栏引用不变、不重渲。
 */
function useSessionBridgeTargets(sessionId: string | undefined): Record<string, BridgeUINode | null> | undefined {
	return useAtomValue(sessionBridgeUiFamily(sessionId ?? NO_SESSION_FAMILY_KEY));
}

/** 订「本会话」的整份桥 UI 状态（状态栏 / 流式行 / 标签 / 覆盖层用；同上按 session 隔离）。 */
function useSessionBridgeUi(sessionId: string | undefined): SessionRuntimeUiState | undefined {
	const ui = useAtomValue(sessionRuntimeUiBySessionIdAtomFamily(sessionId ?? NO_SESSION_FAMILY_KEY));
	return sessionId ? ui : undefined;
}

/** 单个落点的容错边界：崩溃只隐藏该落点。 */
class BridgeSlotBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	constructor(props: { children: ReactNode }) {
		super(props);
		this.state = { failed: false };
	}

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	override componentDidCatch(error: Error, info: ErrorInfo): void {
		// 桥的渲染失败只表现为「这个落点没出现」，不影响 PiDeck（§14.5）
		console.warn("[gui-bridge] 落点渲染失败，已隐藏该落点", error.message, info.componentStack);
	}

	override render(): ReactNode {
		return this.state.failed ? null : this.props.children;
	}
}

/** 桥落点：渲染某个 targetId 的节点树，无内容时返回 null（不占位）。 */
export function BridgeSlot({ sessionId, targetId, className }: { sessionId: string | undefined; targetId: string; className?: string }): ReactNode {
	const targets = useSessionBridgeTargets(sessionId);
	const node = targets?.[targetId];
	const onEvent = useBridgeEventSink(sessionId);
	// 事件带上落点 id，桥侧不必再靠 nodeId 全表扫描猜归属（§8.3）
	const boundEvent = withTarget(onEvent, targetId);
	// 落点挂载 / 绑定变化时向桥要一次快照（§9.4）——桥的落点是一次性推送，
	// 渲染层丢过状态就再也拿不回来。内部按绑定代次去重，不会每个落点发一次。
	useBridgeResync(sessionId);

	if (!node) return null;
	return (
		<BridgeSlotBoundary>
			<div className={className}>{renderBridgeNode(node, boundEvent, targetId)}</div>
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
	const targets = useSessionBridgeTargets(sessionId);
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
			<div className="flex flex-col gap-2">{entries.map(([targetId, node]) => (node ? <div key={targetId}>{renderBridgeNode(node, withTarget(onEvent, targetId), targetId)}</div> : null))}</div>
		</BridgeSlotBoundary>
	);
}

/** 状态栏：桥的 setStatus 多 key 条目（§8.2 A 组 status 是新建项）。 */
export function BridgeStatusBar({ sessionId, className }: { sessionId: string | undefined; className?: string }): ReactNode {
	const status = useSessionBridgeUi(sessionId)?.bridgeStatus;
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
	const working = useSessionBridgeUi(sessionId)?.bridgeWorking;
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
				{showIndicator ? <span className="size-3 animate-pideck-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" /> : null}
				{hasMessage ? <span>{working.message}</span> : null}
			</div>
		</BridgeSlotBoundary>
	);
}

/** 取某落点是否存在内容（供调用方决定是否要渲染自己的容器）。 */
export function useBridgeTargetPresent(sessionId: string | undefined, targetId: string): boolean {
	return Boolean(useSessionBridgeTargets(sessionId)?.[targetId]);
}

// ── B 组：ctx.gui 的 GUI 专属落点（§7.1-B / §8.2 B 组）──────────

/**
 * 把落点 id 绑进事件 sink。
 *
 * 控件只负责报「我是什么 nodeId、发生了什么」，归属由**渲染它的那个落点容器**补上 ——
 * 这样十几个控件的 `onEvent(node.id, ...)` 调用点一行都不用改（§8.3）。
 */
function withTarget(sink: BridgeEventSink, targetId: string | undefined): BridgeEventSink {
	return (nodeId, event) => sink(nodeId, { ...event, targetId } as typeof event);
}

/**
 * 拆开落点 id `gui:<slot>:<owner>@<key>`（§7.7）。
 *
 * `@` 之前是贡献者（`encodeOwnerId` 的产物，保证不含 `@`），之后是 key。有了它，
 * 「两个扩展用同一个 key」不再互相顶掉：桥侧 `bridgeTargets` 的 map key 是完整落点 id，
 * 两个落点各自独立存活。
 *
 * 按**第一个** `@` 切：owner 不含 `@`（由 `encodeOwnerId` 保证），而 key 完全可能出现 `@`
 * （工具名 / 包名里可能有）。没有 `@` 的是旧桥的帧 —— 整段当 key，owner 记 `unknown`，
 * 行为等同旧版单命名空间。
 */
function parseGuiTargetId(slotPrefix: string, targetId: string): { key: string; owner: string } {
	const rest = targetId.slice(slotPrefix.length);
	const at = rest.indexOf("@");
	if (at <= 0) return { key: rest, owner: "unknown" };
	return { owner: rest.slice(0, at), key: rest.slice(at + 1) };
}

/**
 * 取某 GUI 落点下的全部贡献，按 `order` 升序、同 order 按 key 字母序（§7.1-B）。
 *
 * 落点 id 形态是 `gui:<slot>:<owner>@<key>`；`matchKey` 用于「按 key 定位单个贡献」的
 * 附加型落点（`toolExtra` 的 key 是 toolName、`messageExtra` 的 key 是 role）——
 * 它比对的是**去掉 owner 之后的 key**，所以一个 toolName 下多个扩展的贡献会一起渲染。
 *
 * 排序依据是桥推来的 `slot.order`（缺省 1000）。**排序在渲染层做**，
 * 因为桥是「推一帧是一帧」，无法保证到达顺序 —— 宿主排序才是唯一正确的收敛点。
 */
export function useGuiContributions(sessionId: string | undefined, slot: BridgeGuiSlotName, matchKey?: string): { key: string; owner: string; targetId: string; node: BridgeUINode }[] {
	const targets = useSessionBridgeTargets(sessionId);
	return useMemo(() => {
		if (!targets) return [];
		const prefix = `${BRIDGE_TARGET.guiPrefix}${slot}:`;
		const entries: { key: string; owner: string; targetId: string; node: BridgeUINode; order: number }[] = [];
		for (const [targetId, node] of Object.entries(targets)) {
			if (!node || !targetId.startsWith(prefix)) continue;
			const { key, owner } = parseGuiTargetId(prefix, targetId);
			if (matchKey !== undefined && key !== matchKey) continue;
			entries.push({ key, owner, targetId, node, order: node.slot?.order ?? 1000 });
		}
		// 同 order 同 key 时再按 owner 兜底，保证顺序稳定（不依赖对象键序）
		entries.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.key !== b.key ? (a.key < b.key ? -1 : 1) : a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
		return entries.map(({ key, owner, targetId, node }) => ({ key, owner, targetId, node }));
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
export function BridgeGuiSlot({ sessionId, slot, matchKey, className, titleClassName }: { sessionId: string | undefined; slot: BridgeGuiSlotName; matchKey?: string; className?: string; titleClassName?: string }): ReactNode {
	const contributions = useGuiContributions(sessionId, slot, matchKey);
	const onEvent = useBridgeEventSink(sessionId);
	// 同 BridgeSlot：挂载/绑定变化时补一次快照（§9.4）。
	// 设置弹窗关闭时整个弹窗卸载，所以「重开弹窗」也会走到这里。
	useBridgeResync(sessionId);
	if (contributions.length === 0) return null;

	return (
		<BridgeSlotBoundary>
			<div className={className ?? "flex flex-col gap-2"}>
				{contributions.map(({ key, owner, targetId, node }) => (
					// key 用完整落点 id：同 key 不同 owner 的两份贡献必须能共存
					<div key={targetId} data-bridge-slot={targetId} data-bridge-slot-key={`${slot}:${key}`} data-bridge-slot-owner={owner}>
						{/* 分组标题：桥把 opts.title 挂在节点 slot 元信息上（§7.1-B） */}
						{node.slot?.title ? <div className={titleClassName ?? "mb-1 text-[11px] font-medium text-muted-foreground"}>{node.slot.title}</div> : null}
						{renderBridgeNode(node, withTarget(onEvent, targetId), targetId)}
					</div>
				))}
			</div>
		</BridgeSlotBoundary>
	);
}

/**
 * 单个 GUI 贡献（按完整落点 id 精确渲染）。
 *
 * `BridgeGuiSlot` 把落点下的所有贡献堆在一起；需要「一项一个导航页」的落点
 * （`config.page`）得能单独取一项 —— 调用方（导航项）已经知道自己的 targetId，
 * 这里按它精确定位，顺带避开「同 owner 前缀的两个扩展互相顶掉」的可能。
 *
 * 不渲染 `node.slot.title`：标题已经写在调用方的导航项上，再渲染一次就重复了。
 */
export function BridgeGuiSingleSlot({ sessionId, slot, targetId, className }: { sessionId: string | undefined; slot: BridgeGuiSlotName; targetId: string; className?: string }): ReactNode {
	const contributions = useGuiContributions(sessionId, slot);
	const onEvent = useBridgeEventSink(sessionId);
	useBridgeResync(sessionId);
	const hit = contributions.find((contribution) => contribution.targetId === targetId);
	if (!hit) return null;

	return (
		<BridgeSlotBoundary>
			<div className={className} data-bridge-slot={hit.targetId} data-bridge-slot-key={`${slot}:${hit.key}`} data-bridge-slot-owner={hit.owner}>
				{renderBridgeNode(hit.node, withTarget(onEvent, hit.targetId), hit.targetId)}
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
	return useSessionBridgeUi(sessionId)?.bridgeThinkingLabel;
}

/**
 * 落点用的会话 id —— **当前聚焦会话**，也是唯一的取会话入口。
 *
 * 会话内落点（`content.view` / `tool.extra` / …）用它，语义自明；
 * 应用级落点（标题栏 / 设置弹窗 / 右键菜单 / 配置页 / 对话框）**也用它**：
 * 这些位置是单实例 chrome，由「你在哪个会话」的那个 pi 进程供给内容。
 *
 * 为什么不做任何回落（不给「最后一个推过帧的会话」兜底）：桥的贡献只能来自
 * 某个 pi 进程，**没有聚焦会话就没有内容**。这与 pi TUI 的扩展 UI 生命周期一致
 * （`session_start` 挂上、会话失效时 `resetExtensionUI()` 清空）；按「谁最后推谁赢」
 * 回落则会变成多会话互相顶替、会话删除后留下悬空 id。
 *
 * 不违反 AGENTS.md「多实例必须按 session 订阅」—— 那条针对的是分屏/多栏，
 * 单实例 chrome 按聚焦会话取值是语义正确的。`SidebarContent` 由 App 显式透传
 * `currentSessionId` prop，与这里取值同源，只是接线方式不同。
 */
export function useBridgeSessionId(): string | undefined {
	return useAtomValue(currentSessionIdAtom);
}

/** 覆盖层宿主：ctx.gui.custom 的 overlay / modal（§8.2 C 组）。 */
export function BridgeOverlayHost({ sessionId }: { sessionId: string | undefined }): ReactNode {
	const overlays = useSessionBridgeUi(sessionId)?.bridgeOverlays;
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
							<div className={`pointer-events-auto relative m-auto max-h-[80vh] overflow-auto rounded-lg border bg-card p-3 text-card-foreground shadow-lg ${position === "right" ? "ml-auto mr-4 mt-16" : position === "bottom" ? "mb-16 mt-auto" : position === "fullscreen" ? "h-full w-full rounded-none" : ""}`}>
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
