// ============================================================
// AppParts — 产品级顶层桥接文件
// ============================================================
// 本文件保留：
//   1. Overlay domain (EnvironmentDialog re-export, ConfirmDialog)
//   2. 全局类型定义 (SessionModifiedFile, DiffFileHandler)
//   3. Re-exports from leaf modules (Composer, Sidebar, Surface)
// ============================================================

import { useEffect, useState } from "react";
import { ConfirmDialog as ShadcnConfirmDialog } from "../ui-shadcn/ConfirmDialog";

// Re-exports from other modules
export type { WorkspaceDrawerPanel as DrawerPanel } from "../../hooks/useWorkspacePanels";

// Re-exports from leaf modules (A12 migration in progress)
import { PiLogoCanvas } from "./PiLogoCanvas";
import { PiTuiLogoCanvas, useLogoStyle } from "./PiTuiLogo";
import { TextShimmer } from "../motion/text-shimmer";
import { detectRendererPlatform } from "../../lib/detectRendererPlatform";
export { WorktreeCreateDialog } from "../sidebar/SidebarComponents";
export { ComposerBottomBar, ModelPicker, PromptTemplatePicker, ExtensionWidgetCard } from "../session/ComposerComponents";

export type SessionModifiedFile = {
	path: string;
	toolName: string;
	status: string;
	changedLines?: number;
	/** 工具执行前的文件原始内容，用于历史会话恢复时展示差异对比。 */
	originalContent?: string;
	/** 工具写入/编辑后的新文件内容，优先于从磁盘实时读取（历史会话恢复时磁盘可能已变化或文件已删除）。 */
	content?: string;
};

type DiffFileHandler = (path: string, originalContent?: string, content?: string) => void;

// EnvironmentDialog 已收敛到 overlays/OverlayComponents（唯一实现，含 pi 环境三步引导），
// 这里仅保留 re-export 兼容旧 import 路径。
export { EnvironmentDialog } from "../overlays/OverlayComponents";

export function ConfirmDialog(props: { title: string; message: string; onConfirm: () => void; onCancel: () => void; confirmLabel?: string; danger?: boolean }) {
	// 实现已收敛到 ui-shadcn/ConfirmDialog（AlertDialog），此处仅保留兼容转发，
	// 避免一次性改动所有 import 路径；后续批量替换 import 后删除本包装。
	return <ShadcnConfirmDialog {...props} />;
}

// ============================================================
// Re-exports from Surface domain (session rendering components)
// 保持旧 import 路径继续工作
// ============================================================
export {
	SessionStatus,
	LogoMark,
	AgentAvatar,
	EmptyState,
	ToolCard,
	ToolGroupCard,
	DiagnosticMessageCard,
	ThinkingBlock,
	RespondingIndicator,
	AssistantText,
	UserBubble,
	ImagePreviewModal,
	stripMarkdown,
	MultiSelectModal,
	ConversationOutline,
	DrawerContent,
	SessionFileSummary,
	SessionHistoryModal,
	PromptSuggestions,
	FileContextMenu,
} from "../session/SurfaceComponents";
export { TurnRow } from "../session/turn";

// PiLogoCanvas — canvas-based animated pi logo (from upstream dev)
export { PiLogoCanvas } from "./PiLogoCanvas";

/** 模块级缓存：dev 分支名（多 worktree 并行区分窗口）。一次拉取，全实例共享。 */
let cachedDevBranch: string | undefined;
let devBranchPromise: Promise<string | undefined> | null = null;
function loadDevBranch(): Promise<string | undefined> {
	if (cachedDevBranch !== undefined) return Promise.resolve(cachedDevBranch);
	devBranchPromise ??= (async () => {
		try {
			const info = await (window as unknown as { piDesktop?: { app?: { info: () => Promise<{ devBranch?: string }> } } }).piDesktop?.app?.info();
			cachedDevBranch = info?.devBranch?.trim() || undefined;
			return cachedDevBranch;
		} catch {
			return undefined;
		}
	})();
	return devBranchPromise;
}

/**
 * Brand lockup：官方 pi 风格 canvas logo + 两行字标（beUI Animated Sidebar 头部风格的文字排布）。
 * 分支名下探为副标题行（仅开发分支时显示，避免视觉噪声）；视觉变形只作用于字标，
 * 品牌语义仍由外层 aria-label 承载。字标扫光做占空比最小化：每 5 分钟扫一轮
 * （2.5s / 300s ≈ 0.8%），休息态卸掉 bg-clip-text 变成普通实色字——常驻
 * infinite 循环会在高分辨率 × 高刷新率窗口下逼 GPU 进程逐帧合成整窗
 * （实测空闲占约 1 核）。放慢周期只降占空比；真正零帧要靠休息态不挂 clip。
 */
export function BrandLockup() {
	const [branch, setBranch] = useState<string | undefined>(undefined);
	useEffect(() => {
		void loadDevBranch().then(setBranch);
	}, []);
	// 字标扫光：启动即静止，5 分钟后才扫 2.5s，再静止。后台窗口 / 减少动效时停扫。
	const [shimmerOn, setShimmerOn] = useState(false);
	useEffect(() => {
		const SWEEP_MS = 2500;
		const REST_MS = 5 * 60_000;
		const reduceMq = window.matchMedia("(prefers-reduced-motion: reduce)");
		let cancelled = false;
		let timer: number | undefined;
		const clearTimer = () => {
			if (timer !== undefined) {
				window.clearTimeout(timer);
				timer = undefined;
			}
		};
		const canSweep = () => !document.hidden && !reduceMq.matches;
		const arm = (ms: number, nextOn: boolean) => {
			clearTimer();
			timer = window.setTimeout(() => {
				if (cancelled) return;
				// 看不见或系统要求少动效时跳过本轮，避免后台窗口白烧合成。
				if (nextOn && !canSweep()) {
					setShimmerOn(false);
					arm(REST_MS, true);
					return;
				}
				setShimmerOn(nextOn);
				arm(nextOn ? SWEEP_MS : REST_MS, !nextOn);
			}, ms);
		};
		const park = () => {
			setShimmerOn(false);
			arm(REST_MS, true);
		};
		arm(REST_MS, true);
		const onVisibility = () => {
			if (document.hidden) park();
		};
		const onReduceChange = () => {
			if (reduceMq.matches) park();
		};
		document.addEventListener("visibilitychange", onVisibility);
		reduceMq.addEventListener("change", onReduceChange);
		return () => {
			cancelled = true;
			clearTimer();
			document.removeEventListener("visibilitychange", onVisibility);
			reduceMq.removeEventListener("change", onReduceChange);
		};
	}, []);
	const brandTitle = branch ? `PiDeck · ${branch}` : "PiDeck";
	const logoStyle = useLogoStyle();
	// macOS 窗口左上角已有原生交通灯，π logo + 字标挤在同一行视觉过重；
	// darwin 平台只保留字标（品牌语义仍由 aria-label 承载），其余平台维持原样。
	const showLogo = detectRendererPlatform() !== "darwin";
	return (
		<div className="brand-lockup flex h-full min-w-0 items-center gap-2" aria-label={brandTitle} title={branch ? brandTitle : undefined}>
			{/* 默认静态定格；点击 logo 才播落位动画（classic=四块拼图 / pi-tui=三块落位），不随会话启动自动播。 */}
			{showLogo && (logoStyle === "pi-tui" ? <PiTuiLogoCanvas size={18} playOnClick /> : <PiLogoCanvas size={18} playOnClick />)}
			<span className="flex min-w-0 flex-col justify-center gap-1">
				<TextShimmer as="span" enabled={shimmerOn} className="brand-wordmark truncate text-[18px] font-[PiDeckDepartureMono] font-bold uppercase leading-none">
					PiDeck
				</TextShimmer>
				{branch && <span className="truncate text-control font-medium leading-none text-muted-foreground">{branch}</span>}
			</span>
		</div>
	);
}
