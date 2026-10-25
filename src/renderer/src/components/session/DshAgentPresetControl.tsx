/**
 * DSH agent 预设（会话「模式」）控制 —— 会话头左上角胶囊，草稿期可选、激活后只读。
 *
 * 与权限预设不同，agent preset 决定会话的工具与提示，host 在会话创建时
 * 一次性组合（运行中会话一律 agent-preset-locked）。所以同一个胶囊按会话状态
 * 呈现两种形态（对齐 dsh-web 的 new-session chip + session-header label 合并到
 * 会话头一处）：
 * - 未激活草稿（无 runtime、还没 host 会话）：可点击，弹出目录选择器，选择写会话
 *   记录预选，激活新建 host 会话时随 sessions.create 应用；
 * - 已固定（有 runtime / 有 dshSessionId / 已 active）：只读 Badge，展示 host
 *   会话 header 回写的实际 preset（创建即固定）。
 *
 * 两个形态共用 shared/dshAgentPresetLock 判据：锁定时不再发出注定被主进程拒绝的
 * catalog-update，避免「界面能点、点了报错」的假开关。
 *
 * 取值优先级：会话记录回写的实际 preset > host 目录 isDefault（部署默认）；
 * 目录未装配（空 roster）或两者皆无时不渲染。
 */
import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import { dshAgentPresetsAtom, dshDefaultPresetId, sessionRecordByIdAtomFamily, sessionRuntimeBySessionIdAtomFamily, upsertSessionAtom } from "../../atoms";
import { isDshAgentPresetLocked } from "../../../../shared/dshAgentPresetLock";
import { Badge } from "../ui-shadcn/badge";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent } from "../ui-shadcn/dialog";
import { CommandItem } from "../ui-shadcn/command";
import { CommandPickerPanel } from "../ui-shadcn/command-picker";
import { AgentPresetLogo } from "./SessionSourceBadge";
import { presetDisplayDescription, presetDisplayName } from "../../config/dshPresetDisplay";
import { loadDshAgentPresets } from "../../utils/dshAgentPresets";
import { desktopApi } from "../../desktopApi";
import { cn } from "../../lib/utils";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";

/**
 * 预设胶囊配色：按 preset id 分色相。
 *
 * 为什么上色：模式是长期挂在标题栏里的身份信息，早期中性灰描边（text-muted-foreground）
 * 在浅色主题下几乎看不出是个标签，用户要求「像带颜色的按钮」。
 * 未知 id（用户自定义 preset）回退主题色，不给没有约定色相的 id 猜颜色。
 * 浅色 = 淡底 + 深字，暗色 = 亮字 + 低透明底（与 SessionSourceBadge 的 SOURCE_TONES 同惯例）。
 * hover 连文字色一起换：Button ghost 自带 hover:text-accent-foreground，只换底色会让文字与底同色。
 */
type PresetTone = { chip: string; hover: string };
const PRESET_TONES: Record<string, PresetTone> = {
	// 标准模式（完整能力）：蓝色是「默认/主力」的直觉色
	standard: {
		chip: "border-sky-500/25 bg-sky-500/12 text-sky-700 dark:border-sky-400/30 dark:bg-sky-400/15 dark:text-sky-300",
		hover: "hover:bg-sky-500/20 hover:text-sky-800 dark:hover:bg-sky-400/25 dark:hover:text-sky-200",
	},
	// PTC 模式（程序化编排多步操作）：紫色区分「编排」语义
	ptc: {
		chip: "border-violet-500/25 bg-violet-500/12 text-violet-700 dark:border-violet-400/30 dark:bg-violet-400/15 dark:text-violet-300",
		hover: "hover:bg-violet-500/20 hover:text-violet-800 dark:hover:bg-violet-400/25 dark:hover:text-violet-200",
	},
	// 极简模式（双工具）：绿色对应「轻量」
	minimal: {
		chip: "border-emerald-500/25 bg-emerald-500/12 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-300",
		hover: "hover:bg-emerald-500/20 hover:text-emerald-800 dark:hover:bg-emerald-400/25 dark:hover:text-emerald-200",
	},
	// 创造模式（自定义 preset 创作/实验）：琥珀色对应「实验」
	cordis: {
		chip: "border-amber-500/30 bg-amber-500/12 text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/15 dark:text-amber-300",
		hover: "hover:bg-amber-500/20 hover:text-amber-800 dark:hover:bg-amber-400/25 dark:hover:text-amber-200",
	},
};
const FALLBACK_PRESET_TONE: PresetTone = {
	chip: "border-primary/25 bg-primary/12 text-primary",
	hover: "hover:bg-primary/20 dark:hover:bg-primary/25",
};

function presetTone(presetId?: string): PresetTone {
	return (presetId ? PRESET_TONES[presetId] : undefined) ?? FALLBACK_PRESET_TONE;
}

/**
 * catalog-update 失败文案：Electron IPC 拒绝会把主进程错误包成
 * `Error invoking remote method 'x': Error: …`，原样弹给用户既像崩溃又没信息量，
 * 这里只保留主进程真实原因（与 GitPanel 等处的清洗同一语义）。
 */
function presetUpdateErrorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return raw.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/i, "");
}

/** 胶囊尺寸/字号：比标题栏 caption 再小一档，让项目名/标题仍是视觉主体。
 *  必须带 has-[>svg] 的 padding：Button size=sm 自带 has-[>svg]:px-2.5（直接子 svg 即命中），
 *  不覆盖的话 10px 字旁边会撑出 10px 横向内边距。
 *  min-w-0：embedded 时胶囊落在 .chat-header-actions 内，legacy 规则给那里的 button
 *  加了 min-width:60px（topbar 快捷钮定制），会把胶囊撑成固定宽度。 */
const PRESET_CHIP_BASE = "h-[18px] min-w-0 shrink-0 gap-1 rounded-full border px-1.5 has-[>svg]:px-1.5 text-micro font-semibold leading-none";

export function DshAgentPresetControl(props: { sessionId: string; disabled?: boolean }) {
	const record = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId));
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
	const presets = useAtomValue(dshAgentPresetsAtom);
	const upsertSession = useSetAtom(upsertSessionAtom);
	const [open, setOpen] = useState(false);
	const [saving, setSaving] = useState(false);

	const hasRuntime = Boolean(runtime?.agentId);
	// 只给「未激活、还没 host 会话、也没有 runtime」的草稿开着色按钮；其余一律只读。
	// record 未就绪时按 dsh 处理（本组件只挂在 dsh 会话头上），避免闪一下可点胶囊。
	const locked = isDshAgentPresetLocked({
		backend: record?.backend ?? "dsh",
		status: record?.status,
		dshSessionId: record?.dshSessionId,
		hasRuntime,
	});
	const unsentDraft = record?.status === "draft" && !record?.dshSessionId;

	useEffect(() => {
		// 未激活草稿是「默认预设马上就会生效」的唯一场景：强制重拉目录。否则刚改完
		// 默认（设置页保存 / dsh-web / 配置文件）的新会话仍显示旧默认，发出去才变成
		// 实际组合 —— 显示与实际两端分叉。
		void loadDshAgentPresets(unsentDraft ? { force: true } : undefined);
	}, [props.sessionId, unsentDraft]);

	// 胶囊还在选择器里时会话被激活（发送/挂起等）：直接收起弹层，避免继续点一个
	// 注定被主进程拒绝的选项。
	useEffect(() => {
		if (locked) setOpen(false);
	}, [locked]);
	// 生效预设：会话记录回写/预选 > 部署默认（isDefault）；目录未就绪时不猜。
	const presetId = record?.agentPreset ?? (presets ? dshDefaultPresetId(presets) : undefined);
	const identity = presetId ? (presets ?? []).find((preset) => preset.id === presetId) : undefined;
	const label = identity ? presetDisplayName(identity, t) : presetId ? presetId : t("dshPreset.unset");
	const description = identity ? presetDisplayDescription(identity, t) : undefined;
	const tooltip = description ? `${label} — ${description}` : label;

	// 可选择项：剔除 broken（无法组合的预设选了也是白选，dsh-web picker 同规则）。
	const selectable = useMemo(() => (presets ?? []).filter((preset) => !preset.broken), [presets]);

	const tone = presetTone(presetId);

	// 已固定：模式创建即固定，只读展示（不提供假开关）；record 无值时（极端情况）不渲染。
	if (locked) {
		if (!presetId) return null;
		const lockedHint = t("dshPreset.lockedHint");
		return (
			<Badge variant="outline" aria-label={`${t("dshPreset.menuTitle")}: ${label}`} title={`${tooltip}\n${lockedHint}`} data-agent-preset={presetId} size="sm" className={cn(PRESET_CHIP_BASE, tone.chip)}>
				<AgentPresetLogo className="size-3 shrink-0" />
				<span className="max-w-28 truncate">{label}</span>
			</Badge>
		);
	}
	// 目录已确认加载（非 null）但部署未装配预设：无从选择，也不渲染。
	if (presets !== null && selectable.length === 0) return null;
	// 目录加载中/失败（presets === null）：仍渲染可点胶囊，点击时兜底重载
	//（DSH host 首次启动可能数秒，首次请求失败后必须给用户重试入口）。

	const pick = async (chosenId: string) => {
		setSaving(true);
		try {
			const updated = await desktopApi.sessions.updateRecord(props.sessionId, { agentPreset: chosenId });
			upsertSession(updated);
			const chosen = selectable.find((preset) => preset.id === chosenId);
			showNotice(
				t("dshPreset.presetPendingNotice", {
					name: chosen ? presetDisplayName(chosen, t) : chosenId,
				}),
				3000,
			);
			setOpen(false);
		} catch (error) {
			showNotice(presetUpdateErrorMessage(error), 4000);
		} finally {
			setSaving(false);
		}
	};

	const openPicker = () => {
		// 目录未就绪（首次加载失败/host 启动慢）时先兜底重载；已缓存则秒回。
		// 重载完成后 atom 更新，弹层内容自动刷新。
		void loadDshAgentPresets();
		setOpen(true);
	};

	return (
		<>
			<Button type="button" variant="ghost" size="sm" className={cn(PRESET_CHIP_BASE, tone.chip, tone.hover)} disabled={props.disabled || saving} aria-label={t("dshPreset.menuTitle")} title={`${t("dshPreset.menuTitle")}: ${tooltip}`} onClick={openPicker}>
				<AgentPresetLogo className="size-3 shrink-0" />
				<span className="max-w-28 truncate">{label}</span>
			</Button>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!next) setOpen(false);
				}}
			>
				<DialogContent showCloseButton={false} className="dsh-preset-picker flex max-h-[min(680px,calc(100vh-48px))] flex-col overflow-hidden p-0 sm:max-w-[min(560px,calc(100vw-48px))]">
					<CommandPickerPanel title={t("dshPreset.menuTitle")} hint={t("dshPreset.menuHint")} searchPlaceholder={t("app.commandPickerSearch")} emptyLabel={t("app.commandPickerEmpty")} value={presetId ?? ""} onClose={() => setOpen(false)}>
						{selectable.map((preset) => {
							const itemSelected = presetId === preset.id;
							const presetName = presetDisplayName(preset, t);
							const presetDesc = presetDisplayDescription(preset, t);
							return (
								<CommandItem key={preset.id} value={preset.id} data-picker-value={preset.id} onSelect={() => void pick(preset.id)} disabled={saving} className="min-h-9 items-center gap-2 rounded-md px-2.5 py-1">
									<span className={`grid size-6 shrink-0 place-items-center rounded-md ${itemSelected ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"}`}>
										<AgentPresetLogo className="size-3.5" />
									</span>
									{/* 名字保持短小固定（超长才截断）；描述吃满剩余宽度——能显示多少显示多少，
									    放不下的部分悬停（title）显示完整文案。 */}
									<div className="flex min-w-0 flex-1 items-center gap-2">
										<span className="max-w-28 shrink-0 truncate text-control font-semibold text-foreground" title={presetName}>
											{presetName}
										</span>
										{presetDesc ? (
											<span className="min-w-0 flex-1 truncate text-micro text-muted-foreground/75" title={presetDesc}>
												{presetDesc}
											</span>
										) : (
											<span className="shrink-0 font-mono text-micro text-muted-foreground/60" title={preset.id}>
												{preset.id}
											</span>
										)}
									</div>
									{itemSelected ? <Check size={15} className="ml-auto shrink-0 text-primary" aria-hidden="true" /> : null}
								</CommandItem>
							);
						})}
					</CommandPickerPanel>
				</DialogContent>
			</Dialog>
		</>
	);
}
