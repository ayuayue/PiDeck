/**
 * 宠物通知/精灵的纯几何与字号映射 —— 主进程（PetWindow/PetSystem）与宠物 renderer
 * （PetOverlay）共用同一套规格，避免窗口尺寸与 Canvas 绘制各自猜测缩放比例。
 *
 * 设计约定：
 * - 精灵基础尺寸与 petdex 单格一致：192×208。历史窗口曾用 160×176，
 *   会把 192×208 帧压扁并叠加 pixelated 缩放，桌面上发糊、发小。
 * - 提醒气泡显示在精灵头顶：窗口在通知可见时扩展出「气泡槽位 + 间距」区域。
 * - 气泡文字使用有效 UI 字号（uiFontSize ?? fontSize），与 foundation.css 的
 *   --font-size-control 对齐；绝不随 petScale 缩放。
 * - 窗口切换尺寸时以「精灵脚底中心」为稳定锚点，宠物脚底位置不跳动。
 */

import type { AppFontBaseMode, AppFontSizeMode } from "./types/settings";

/** 精灵基础宽度（CSS px，petScale=1 时窗口宽度；与 spritesheet 单格同宽） */
export const PET_BASE_W = 192;
/** 精灵基础高度（CSS px，petScale=1 时窗口高度；与 spritesheet 单格同高） */
export const PET_BASE_H = 208;

/** UI 字号档位 → 提醒气泡 CSS 字号（px）；与 foundation.css --font-size-control 一致 */
export const NOTIFICATION_FONT_SIZE_PX: Record<AppFontSizeMode, number> = {
	compact: 12,
	medium: 14,
	large: 15,
	xlarge: 16,
};

/** 气泡横向内边距（CSS px） */
export const NOTIFICATION_PAD_X = 12;
/** 气泡纵向内边距（CSS px） */
export const NOTIFICATION_PAD_Y = 8;
/** 气泡描边宽度（CSS px） */
export const NOTIFICATION_STROKE = 1.5;
/** 气泡底边到精灵顶边的间距（CSS px） */
export const NOTIFICATION_GAP = 6;
/** 标题最大行数，超出省略号截断 */
export const NOTIFICATION_MAX_LINES = 2;
/** 气泡最大宽度（CSS px） */
export const NOTIFICATION_MAX_WIDTH = 240;
/** 非持久化通知展示时长（ms），由主进程统一计时并在结束后收缩窗口 */
export const NOTIFICATION_DURATION_MS = 4000;

/** 有效 UI 字号档位：uiFontSize 未单独设置时回退全局 fontSize */
export function effectiveUIFontSize(uiFontSize: AppFontSizeMode | null | undefined, fontSize: AppFontSizeMode): AppFontSizeMode {
	return uiFontSize ?? fontSize;
}

export type PetLayout = {
	scale: number;
	fontMode: AppFontSizeMode;
	/** 气泡 CSS 字号（px），不随 scale 变化 */
	fontSizePx: number;
	spriteW: number;
	spriteH: number;
	notificationVisible: boolean;
	/** 气泡槽位宽度：最大气泡宽 + 左右 padding + 描边 */
	notificationSlotW: number;
	/** 气泡槽位高度：最大两行文本 + 上下 padding + 描边 */
	notificationSlotH: number;
	/** 窗口目标宽度（CSS px） */
	windowW: number;
	/** 窗口目标高度（CSS px） */
	windowH: number;
	bubbleMaxWidth: number;
};

/** 由缩放 + 字号档位 + 通知可见性推导窗口/精灵/气泡几何 */
export function petLayout(args: { scale: number; fontMode: AppFontSizeMode; notificationVisible: boolean }): PetLayout {
	const scale = Math.max(0.1, Number.isFinite(args.scale) ? args.scale : 1);
	const fontMode = args.fontMode;
	const fontSizePx = NOTIFICATION_FONT_SIZE_PX[fontMode];
	const spriteW = Math.round(PET_BASE_W * scale);
	const spriteH = Math.round(PET_BASE_H * scale);
	const bubbleMaxWidth = NOTIFICATION_MAX_WIDTH;
	const notificationSlotW = Math.round(bubbleMaxWidth + NOTIFICATION_PAD_X * 2 + NOTIFICATION_STROKE * 2);
	const notificationSlotH = Math.round(fontSizePx * 1.5 * NOTIFICATION_MAX_LINES + NOTIFICATION_PAD_Y * 2 + NOTIFICATION_STROKE * 2);
	const notificationVisible = args.notificationVisible;
	const windowW = notificationVisible ? Math.max(spriteW, notificationSlotW) : spriteW;
	const windowH = notificationVisible ? spriteH + NOTIFICATION_GAP + notificationSlotH : spriteH;
	return {
		scale,
		fontMode,
		fontSizePx,
		spriteW,
		spriteH,
		notificationVisible,
		notificationSlotW,
		notificationSlotH,
		windowW,
		windowH,
		bubbleMaxWidth,
	};
}

export type Size2D = { width: number; height: number };
export type WorkArea = { x: number; y: number; width: number; height: number };
export type Pos2D = { x: number; y: number };

/**
 * 从任意布局尺寸切换时，保持「精灵脚底中心」不变的窗口左上角。
 * 两种布局下精灵都底部对齐，因此脚底 = 窗口底边中点。
 */
export function keepFeetCenter(from: { x: number; y: number; width: number; height: number }, to: Size2D): Pos2D {
	const feetX = from.x + from.width / 2;
	const feetY = from.y + from.height;
	return {
		x: Math.round(feetX - to.width / 2),
		y: Math.round(feetY - to.height),
	};
}

/** 把当前任意布局的窗口左上角换算成「普通布局（无通知槽位）」下的位置，用于持久化 */
export function toNormalLayoutPosition(pos: Pos2D, currentSize: Size2D, normalSize: Size2D): Pos2D {
	const feetX = pos.x + currentSize.width / 2;
	const feetY = pos.y + currentSize.height;
	return {
		x: Math.round(feetX - normalSize.width / 2),
		y: Math.round(feetY - normalSize.height),
	};
}

/** 把窗口钳制到 workArea 内，保证整个窗口可见 */
export function clampToWorkArea(rect: { x: number; y: number; width: number; height: number }, wa: WorkArea): Pos2D {
	const maxX = wa.x + wa.width - rect.width;
	const maxY = wa.y + wa.height - rect.height;
	return {
		x: Math.round(Math.min(maxX, Math.max(wa.x, rect.x))),
		y: Math.round(Math.min(maxY, Math.max(wa.y, rect.y))),
	};
}

// ═══ 气泡字体与分段排版（Canvas 绘制用，纯函数可测） ═══

/** 默认系统字体栈（与 foundation.css data-font-base="system" 一致） */
export const DEFAULT_PET_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "HarmonyOS Sans SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif';

/** 按 PiDeck 字体设置解析气泡字体栈（system/sans/serif 预设与 custom 用户字体） */
export function petFontStack(fontBase: AppFontBaseMode, customFont: string): string {
	switch (fontBase) {
		case "sans":
			return '"Inter", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "HarmonyOS Sans SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif';
		case "serif":
			return 'Georgia, "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "SimSun", serif';
		case "custom": {
			// 用户字体通常只填西文字体：必须追加 CJK 回退，否则中文经 FontLink 落到 SimSun
			//（11px 小字合成粗体后笔画挤压，与主界面 mono 栈同因，见 foundation.css 注释）。
			const font = customFont.trim();
			return font ? `${font}, "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "HarmonyOS Sans SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif` : DEFAULT_PET_FONT_STACK;
		}
		default:
			return DEFAULT_PET_FONT_STACK;
	}
}

/**
 * 按注入的测量函数换行（与 Canvas 解耦）。逻辑与旧 PetOverlay.wrapText 一致：
 * 按空格分词，超宽单词逐字符拆，适配中文无空格长串。
 */
export function wrapTextByMeasure(measure: (text: string) => number, text: string, maxW: number): string[] {
	if (maxW <= 0 || measure(text) <= maxW) return [text];
	const lines: string[] = [];
	const words = text.split(" ");
	let cur = "";
	for (const word of words) {
		const trial = cur ? cur + " " + word : word;
		if (measure(trial) <= maxW) {
			cur = trial;
			continue;
		}
		if (cur) {
			lines.push(cur);
			cur = "";
		}
		if (measure(word) <= maxW) {
			cur = word;
			continue;
		}
		let chunk = "";
		for (const ch of word) {
			if (measure(chunk + ch) > maxW && chunk) {
				lines.push(chunk);
				chunk = ch;
			} else chunk += ch;
		}
		cur = chunk;
	}
	if (cur) lines.push(cur);
	return lines;
}

/** 最多保留 maxLines 行，最后一行超宽时用省略号截断 */
export function clipLinesByMeasure(measure: (text: string) => number, text: string, maxW: number, maxLines: number): string[] {
	const lines = wrapTextByMeasure(measure, text, maxW);
	if (lines.length <= maxLines) return lines;
	const out = lines.slice(0, maxLines);
	let last = out[maxLines - 1];
	while (last.length > 0 && measure(last + "…") > maxW) last = last.slice(0, -1);
	out[maxLines - 1] = last + "…";
	return out;
}

/** 一行内的着色段：标题用黑色，状态词用状态色 */
export type NotificationSegment = { text: string; kind: "title" | "status" };

/**
 * 通知气泡分段排版：标题黑色段 + 状态词状态色段。
 * 状态词尾随标题最后一行行尾（带前导空格）；标题为空或状态词超宽时状态词独立成行。
 */
export function layoutNotificationSegments(measure: (text: string) => number, title: string, status: string, maxW: number, maxLines: number): NotificationSegment[][] {
	const statusWithGap = "  " + status; // 双空格：中文引号与状态词之间的分隔在 Canvas 中文字体下更明显
	// 标题为空：状态词独立一行
	if (!title.trim()) {
		return [[{ text: status, kind: "status" }]];
	}
	const statusW = measure(statusWithGap);
	// 状态词超宽：独占一行（标题让出一行空间）
	if (statusW > maxW) {
		const titleLines = clipLinesByMeasure(measure, title, maxW, Math.max(1, maxLines - 1));
		const rows: NotificationSegment[][] = titleLines.map((t) => [{ text: t, kind: "title" as const }]);
		rows.push([{ text: status, kind: "status" as const }]);
		return rows;
	}
	const titleMaxW = maxW - statusW;
	const titleLines = clipLinesByMeasure(measure, title, titleMaxW, maxLines);
	const rows: NotificationSegment[][] = titleLines.map((t) => [{ text: t, kind: "title" as const }]);
	rows[rows.length - 1].push({ text: statusWithGap, kind: "status" });
	return rows;
}
