import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { useAtomValue } from "jotai";
import { dshModuleHiddenAtom, imageGenModuleHiddenAtom, videoGenModuleHiddenAtom, acpEnabledAtom, acpToolsAtom } from "../../atoms";
import { AlertCircle, BrainCircuit, Check, ChevronDown, ChevronLeft, ChevronRight, Clapperboard, CornerDownLeft, Eye, EyeOff, FileText, GitBranch, ImageIcon, LayoutGrid, ListChecks, Loader2, Paperclip, RefreshCw, Settings2, Sparkles, Star, Target, X, Zap } from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import type { PromptEnhanceView } from "../../hooks/usePromptEnhance";
import { PromptEnhanceControls } from "./PromptEnhanceControls";
import { Button } from "../ui-shadcn/button";
import { Collapsible, CollapsibleContent } from "../ui-shadcn/collapsible";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "../ui-shadcn/command";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { cn } from "../../lib/utils";
import { showNotice } from "../../utils/notice";
import { ModelThinkingChip } from "./ModelThinkingChip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { ConfirmDialog } from "../app/AppParts";
import { ComposerImageGenOptions } from "./ComposerImageGenOptions";
import { ComposerVideoGenOptions } from "./ComposerVideoGenOptions";
import { useComposerModeAvailability } from "../../hooks/useComposerModeAvailability";
import type { ImageGenConfigFile } from "../../../../shared/imageGenConfig";
import type { VideoGenConfigFile } from "../../../../shared/videoGenConfig";
import { ProviderUsageInline } from "../app/ProviderUsageInline";
import { useProviderUsageBatchRefresh } from "../../hooks/useProviderUsage";
import { AcpToolLogo, DshLogo, PiLogo } from "./SessionSourceBadge";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "../ui-shadcn/select";
import { computeModelDisplay, formatModelRef, resolveComposerLiveModel, resolveGuideDisplayModel, type ModelPending } from "../../utils/modelPendingDisplay";
import { WELCOME_DSH_MODEL_KEY, WELCOME_MODEL_KEY, isWelcomeModelLost, readWelcomeDshModelPreference, readWelcomeModelPreference, shouldClearWelcomePreference } from "../../utils/chatSessionBootstrap";
import { useBackendModelCatalog } from "../../hooks/useBackendModelCatalog";
import { CommandPickerGroup, CommandPickerPanel, type CommandPickerFilter } from "../ui-shadcn/command-picker";
import { computeModelPickerDefaultExpanded, groupModelsByProvider, modelPickerSearchFilter, modelRowLabel, modelRowName, orderProviderGroups, resolveModelPickerBody } from "./sessionPickerOptions";
import { ComposerModeChip } from "./composer/ComposerModeChip";
import type { AgentBackend, AgentRuntimeState, AvailableModel, ComposerAgentMode, GitBranchInfo, ModelListFailReason, ModelListReport, SessionRecord, SessionRuntimeTarget, UsageProbeBackend } from "../../../../shared/types";

/** 单个 extension widget 卡片：可折叠标题栏 + 内容行，支持手动关闭 */
// widgetKey 由扩展定义且跨重启稳定,可按 widgetKey 持久化折叠状态。
const EXTENSION_WIDGET_COLLAPSED_KEY_PREFIX = "pid:extension-widget-collapsed:";

/** 模式项标签文案（与旧 ComposerModeSelect 的 MODE_OPTIONS 同源）。 */
const MODE_LABEL: Record<ComposerAgentMode, TranslationKey> = {
	normal: "app.composerModeNormal",
	goal: "app.composerModeGoal",
	plan: "app.composerModePlan",
	imagegen: "app.composerModeImagegen",
	videogen: "app.composerModeVideogen",
};

/**
 * 特殊模式 chip 与「+」菜单模式项的短名：底栏不再出现「模式」二字（2026-10 用户反馈）。
 * 全名仍在 MODE_LABEL 里，供可访问名、菜单悬浮说明与其它界面（会话 Tab 徽标、自动化任务编辑器）使用。
 */
const MODE_SHORT_LABEL: Partial<Record<ComposerAgentMode, TranslationKey>> = {
	goal: "app.composerModeGoalShort",
	plan: "app.composerModePlanShort",
};

/** 「+」菜单模式项的悬浮说明：在菜单里就能知道这个模式做什么，不用先选一次再试。 */
const MODE_DESC_LABEL: Partial<Record<ComposerAgentMode, TranslationKey>> = {
	goal: "app.composerModeGoalDesc",
	plan: "app.composerModePlanDesc",
};

/** 特殊模式 chip 的退出文案：计划=取消本轮计划、目标=暂停自动推进（与旧退出×同一套文案）。 */
const MODE_EXIT_LABEL: Partial<Record<ComposerAgentMode, TranslationKey>> = {
	goal: "app.composerModeCancelGoal",
	plan: "app.composerModeCancelPlan",
};

/** 模式图标：普通=闪电（直接执行），规划=清单，目标=靶心，生图=图片，生视频=场记板。
 * 2026-10 起普通模式不再在底栏摆图标（普通态 = 没有 chip），但映射保持一致，
 * 供「+」菜单/其它消费方按同一个入口取图标。 */
function modeGlyph(mode: ComposerAgentMode) {
	if (mode === "plan") return <ListChecks size={14} strokeWidth={2} aria-hidden="true" />;
	if (mode === "imagegen") return <ImageIcon size={14} strokeWidth={2} aria-hidden="true" />;
	if (mode === "videogen") return <Clapperboard size={14} strokeWidth={2} aria-hidden="true" />;
	if (mode === "goal") return <Target size={14} strokeWidth={2} aria-hidden="true" />;
	return <Zap size={14} strokeWidth={2} aria-hidden="true" />;
}

/** 渲染 widget 单行内容，将 ✓/☑ 完成标记高亮为绿色，让 todo/plan 扩展的完成态更醒目。 */
export function renderWidgetLine(line: string): ReactNode {
	const parts = line.split(/(✓|☑)/g);
	if (parts.length <= 1) return line;
	return parts.map((part, i) =>
		part === "✓" || part === "☑" ? (
			<span key={i} className="widget-check-done">
				{part}
			</span>
		) : (
			part
		),
	);
}

/** 内置扩展 widget 的展示标题：widgetKey 是扩展内部标识（如 pi-deck-todo），直接展示不友好，映射为固定短名。 */
export function widgetDisplayTitle(widgetKey: string): string {
	if (widgetKey === "pi-deck-todo") return t("app.widgetTitleTodo");
	if (widgetKey === "pi-deck-plan-todos") return t("app.widgetTitlePlan");
	return widgetKey;
}

export function ExtensionWidgetCard(props: {
	widgetKey: string;
	lines: string[];
	onClose: () => void;
	/** 会话唯一标识，用于避免 Todo 等同名 widget 在不同 agent 间共享折叠状态。 */
	sessionIdOrPath?: string;
}) {
	const storageKey = props.sessionIdOrPath ? `${EXTENSION_WIDGET_COLLAPSED_KEY_PREFIX}${props.sessionIdOrPath}:${props.widgetKey}` : `${EXTENSION_WIDGET_COLLAPSED_KEY_PREFIX}${props.widgetKey}`;
	const [expanded, setExpanded] = useState(() => {
		if (typeof window === "undefined") return true;
		const stored = localStorage.getItem(storageKey);
		return stored !== null ? stored === "true" : true;
	});
	const prevStorageKeyRef = useRef(storageKey);

	// 切换 agent/session 时只读取对应 key，不把上一 agent 的状态写到新 key。
	useEffect(() => {
		if (prevStorageKeyRef.current === storageKey) return;
		prevStorageKeyRef.current = storageKey;
		const stored = localStorage.getItem(storageKey);
		setExpanded(stored !== null ? stored === "true" : true);
	}, [storageKey]);

	const handleToggleExpanded = useCallback(() => {
		setExpanded((prev) => {
			const next = !prev;
			localStorage.setItem(storageKey, String(next));
			return next;
		});
	}, [storageKey]);

	return (
		<div className="extension-widget-card">
			<div className="extension-widget-card-header">
				<button className="extension-widget-card-trigger" onClick={handleToggleExpanded} aria-expanded={expanded}>
					<ChevronDown size={14} className={`extension-widget-card-chevron${expanded ? " open" : ""}`} />
					<span className="extension-widget-card-title">{widgetDisplayTitle(props.widgetKey)}</span>
				</button>
				<button
					className="extension-widget-card-close"
					onClick={(e) => {
						e.stopPropagation();
						props.onClose();
					}}
					title={t("common.close")}
					aria-label={t("common.close")}
				>
					<X size={12} strokeWidth={2} />
				</button>
			</div>
			{/* 折叠体走共享折叠原语（真高度渐变 + exit 后卸载 + reduced-motion 回退）；
			    contents 根不生成盒子；限高/间距样式留在 .extension-widget-card-content 上。
			    overflow-y-auto 必须补在 utility 层：原语基底的 overflow-hidden 也在 utilities 层且
			    会赢过 legacy 层 .extension-widget-card-content 的 overflow-y:auto，不补会让内部滚动失效。 */}
			<Collapsible open={expanded} className="contents">
				<CollapsibleContent className="extension-widget-card-content overflow-y-auto">
					{props.lines.map((line, index) => (
						<div key={index} className="extension-widget-card-line">
							{renderWidgetLine(line)}
						</div>
					))}
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}

/** 输入框底栏的后端选择下拉（pi / dsh / 生图）：跟随会话后端（新建会话默认 pi，由设置项 defaultAgentBackend 决定）。
 * 触发区只显示当前后端 logo（不再带文字）；下拉选项保留文字便于选择时区分。
 * 用户在设置里隐藏了 DSH / 生图模块时不列对应选项；但当前草稿已选中该后端时仍保留，
 * 否则 Select 的当前值在列表里没有对应项，用户也无法看清自己选了什么。 */
/**
 * ACP 会话配置选择器组：按 category 渲染 agent 回传的 configOptions——
 * model → 模型下拉、thought_level → 思考下拉、mode/其他 → 通用下拉。
 * 只处理 select 型且带枚举的 option(boolean 型需 client 通告,主流 agent 未用);
 * 分组值(options[].group)平铺渲染。值变化经 onSet 下发,整表由事件/响应回填。
 */
function AcpConfigControls(props: { options: import("../../../../shared/types/acp").AcpSessionConfigOption[]; disabled?: boolean; onSet: (optionId: string, value: string | boolean) => void }) {
	const entries = flattenConfigOptions(props.options).filter((entry) => entry.values.length > 0);
	if (entries.length === 0) return null;
	return (
		<>
			{entries.map((entry) => (
				<Select key={entry.option.id} value={String(entry.option.currentValue ?? "")} disabled={props.disabled} onValueChange={(value) => props.onSet(entry.option.id, value)}>
					<SelectTrigger
						size="sm"
						className="composer-bar-btn backend h-7 gap-1 rounded-md border-transparent bg-transparent px-1.5 text-control font-semibold text-foreground hover:bg-muted/60 focus-visible:border-transparent focus-visible:ring-0 data-[state=open]:border-transparent data-[state=open]:bg-muted/60 data-[state=open]:ring-0 max-w-44 [&_[data-slot='select-icon']]:hidden"
						title={`${entry.option.name}${entry.option.description ? ` — ${entry.option.description}` : ""}`}
					>
						{entry.option.category === "model" ? (
							<Sparkles className="size-[15px] shrink-0 text-muted-foreground" aria-hidden="true" />
						) : entry.option.category === "thought_level" ? (
							<BrainCircuit className="size-[15px] shrink-0 text-muted-foreground" />
						) : (
							<Settings2 className="size-[15px] shrink-0 text-muted-foreground" />
						)}
						<span className="truncate text-xs">{currentValueName(entry)}</span>
					</SelectTrigger>
					<SelectContent align="start" className="max-h-72">
						{entry.values.map((value) => (
							<SelectItem key={value.value} value={value.value}>
								<span className="truncate">{value.name}</span>
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			))}
		</>
	);
}

/** 平铺 configOptions 的取值枚举(group 结构展平),过滤空枚举。 */
function flattenConfigOptions(options: import("../../../../shared/types/acp").AcpSessionConfigOption[]): Array<{ option: import("../../../../shared/types/acp").AcpSessionConfigOption; values: Array<{ value: string; name: string }> }> {
	const result = [];
	for (const option of options) {
		if (option.type === "boolean") continue;
		const values: Array<{ value: string; name: string }> = [];
		for (const item of option.options ?? []) {
			if ("group" in item) {
				for (const inner of item.options) values.push({ value: inner.value, name: item.name ? `${item.name} / ${inner.name}` : inner.name });
			} else {
				values.push({ value: item.value, name: item.name });
			}
		}
		result.push({ option, values });
	}
	return result;
}

/** 当前值的显示名(枚举里找不到时回退原值,如 agent 只回 currentValue 不回枚举)。 */
function currentValueName(entry: { option: import("../../../../shared/types/acp").AcpSessionConfigOption; values: Array<{ value: string; name: string }> }): string {
	const raw = entry.option.currentValue;
	if (raw === undefined) return entry.option.name;
	const text = String(raw);
	return entry.values.find((value) => value.value === text)?.name ?? text;
}

/**
 * ACP 工具品牌标记：按 acpToolId 从已登记工具里查（工具已被删除时找不到 → 通用终端图标）。
 * 下拉触发器与后端锁定态的只读标识共用，避免两处各写一遍查找逻辑。
 */
function AcpToolMark(props: { acpToolId?: string; className: string }) {
	const acpTools = useAtomValue(acpToolsAtom);
	return <AcpToolLogo tool={acpTools.find((tool) => tool.id === props.acpToolId)} className={props.className} />;
}

export function ComposerBackendPicker(props: { backend: AgentBackend; acpToolId?: string; disabled?: boolean; onChangeBackend: (backend: AgentBackend, acpToolId?: string) => void }) {
	const dshHidden = useAtomValue(dshModuleHiddenAtom);
	const imageGenHidden = useAtomValue(imageGenModuleHiddenAtom);
	const videoGenHidden = useAtomValue(videoGenModuleHiddenAtom);
	// ACP 是 opt-in：开关开启且登记了工具才列入口；已是 acp 会话时始终保留
	//（同 dsh/imagegen 的「+当前后端」规则，避免切走后回不来）。
	const acpEnabled = useAtomValue(acpEnabledAtom);
	const acpTools = useAtomValue(acpToolsAtom);
	const showAcp = (acpEnabled && acpTools.length > 0) || props.backend === "acp";
	// 当前工具名：ACP 只显示图标，名称靠 title/aria-label 保留（用户反馈「看不出是 OpenCode
	// 还是 Codex」）——logo 区分品牌，悬停/读屏再给具体名称。
	const currentTool = props.backend === "acp" ? acpTools.find((tool) => tool.id === props.acpToolId) : undefined;
	const triggerLabel = currentTool?.name ?? t("sessionBackend.acp");
	const showDsh = !dshHidden || props.backend === "dsh";
	const showImageGen = !imageGenHidden || props.backend === "imagegen";
	const showVideoGen = !videoGenHidden || props.backend === "videogen";
	// 单层下拉 + 选项组：Agent CLI 组下直接列工具项（value 携带工具 id），
	// 选中即切换后端+工具，radix 正常关弹层——不做两页式跳转（radix 选中项
	// 会强制关弹层，受控拦截在异步 setState 下时序不稳，实测点选后弹层闪退）。
	// 受控 value：acp 会话映射到「acp:<toolId>」才能在组内高亮当前工具。
	const value = props.backend === "acp" && props.acpToolId ? `acp:${props.acpToolId}` : props.backend;
	return (
		<Select
			value={value}
			disabled={props.disabled}
			onValueChange={(next) => {
				if (next.startsWith("acp:")) {
					props.onChangeBackend("acp", next.slice("acp:".length));
					return;
				}
				props.onChangeBackend(next as AgentBackend);
			}}
		>
			<SelectTrigger
				size="sm"
				/* size-7 + p-0 + justify-center = 与底栏其它图标按钮同一个 28×28 盒子；
				   data-[size=sm]:h-7 必需——SelectTrigger 基底高度是 data 变体，
				   base h-7 既压不过它，也不会被 tailwind-merge 合成一条。 */
				className="composer-bar-btn backend size-7 justify-center rounded-md border-transparent bg-transparent p-0 text-control font-semibold text-foreground hover:bg-muted/60 focus-visible:border-transparent focus-visible:ring-0 data-[size=sm]:h-7 data-[state=open]:border-transparent data-[state=open]:bg-muted/60 data-[state=open]:ring-0 [&_[data-slot='select-icon']]:hidden"
				title={`${triggerLabel} · ${t("session.backendPickerHint")}`}
				aria-label={triggerLabel}
			>
				{/* 不渲染 SelectValue：按当前后端手动渲染 logo，输入框只显示图标不带文字。
				    隐藏 shadcn SelectTrigger 自带的 chevron（[data-slot='select-icon']），
				    否则 logo 与 chevron 并排（justify-between）→ 图标偏左不居中、
				    16px chevron 与 14px logo 混排导致上下不齐。 */}
				{props.backend === "dsh" ? (
					<DshLogo className="size-[15px] shrink-0" />
				) : props.backend === "imagegen" ? (
					<ImageIcon className="size-[15px] shrink-0 text-muted-foreground" />
				) : props.backend === "videogen" ? (
					<Clapperboard className="size-[15px] shrink-0 text-muted-foreground" />
				) : props.backend === "acp" ? (
					<AcpToolMark acpToolId={props.acpToolId} className="size-[15px] shrink-0" />
				) : (
					<PiLogo className="size-[15px] shrink-0" />
				)}
			</SelectTrigger>
			<SelectContent align="start">
				<SelectItem value="pi">
					<PiLogo className="size-3.5 shrink-0" />
					{t("sessionSource.pi")}
				</SelectItem>
				{showDsh ? (
					<SelectItem value="dsh">
						<DshLogo className="size-3.5 shrink-0" />
						{t("sessionBackend.dsh")}
					</SelectItem>
				) : null}
				{showVideoGen ? (
					<SelectItem value="videogen">
						<Clapperboard className="size-3.5 shrink-0 text-muted-foreground" />
						{t("sessionBackend.videogen")}
					</SelectItem>
				) : null}
				{showImageGen ? (
					<SelectItem value="imagegen">
						<ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
						{t("sessionBackend.imagegen")}
					</SelectItem>
				) : null}
				{showAcp ? (
					<SelectGroup>
						<SelectLabel className="text-xs text-muted-foreground">{t("sessionBackend.acp")}</SelectLabel>
						{acpTools.map((tool) => (
							<SelectItem key={tool.id} value={`acp:${tool.id}`}>
								<AcpToolLogo tool={tool} className="size-3.5 shrink-0" />
								<span className="truncate">{tool.name}</span>
							</SelectItem>
						))}
					</SelectGroup>
				) : null}
			</SelectContent>
		</Select>
	);
}

/**
 * 底栏右侧分支切换器（shadcn 下拉）：当前分支 chip 即触发器，展开分支列表；
 * 选择目标分支后先弹确认（切换会携带未提交更改、冲突时 git 会拒绝），
 * 确认后才调 onSwitchBranch——owner 在 App 级（switchBranch 统一刷新
 * gitInfo/branchByProject），让右侧 Git 面板与底栏分支保持同步，不在此组件内
 * 再开一条 git 通道。无分支数据时回退为只读 span（由调用方兜底）。
 */
function ComposerBranchSwitcher(props: { gitInfo: GitBranchInfo; disabled?: boolean; onSwitchBranch: (branch: string) => void }) {
	const [pendingBranch, setPendingBranch] = useState<string | null>(null);
	return (
		<>
			{/* Radix DropdownMenu.Root 无 disabled 属性：禁用统一落在 trigger Button（已 disabled） */}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className="composer-bar-btn branch h-7 max-w-[12rem] gap-1 rounded-md px-1.5 text-control font-medium text-muted-foreground hover:bg-muted/60"
						title={t("app.branchCurrent", {
							branch: props.gitInfo.current,
							count: props.gitInfo.branches.length,
						})}
					>
						<GitBranch size={15} strokeWidth={1.8} aria-hidden="true" />
						<span className="composer-bar-branch-name min-w-0 truncate">{props.gitInfo.current}</span>
						<ChevronDown size={12} strokeWidth={2} aria-hidden="true" className="shrink-0 text-muted-foreground" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" sideOffset={4} className="min-w-56">
					{props.gitInfo.branches.map((branch) => {
						const current = branch === props.gitInfo.current;
						return (
							<DropdownMenuItem
								key={branch}
								// 当前分支不可再选（切换自身无意义）；选择后不立即切换，先走确认
								disabled={current}
								onSelect={() => setPendingBranch(branch)}
								className="min-h-8 gap-2 px-2.5 py-1"
							>
								<span className={`grid size-6 shrink-0 place-items-center rounded-md ${current ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"}`}>
									<GitBranch size={13} strokeWidth={2} aria-hidden="true" />
								</span>
								<span className="min-w-0 flex-1 truncate font-mono text-caption text-foreground">{branch}</span>
								{current ? <Check size={14} strokeWidth={2} className="shrink-0 text-primary" aria-hidden="true" /> : null}
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuContent>
			</DropdownMenu>
			{pendingBranch && (
				<ConfirmDialog
					title={t("git.branchSwitcherConfirmTitle")}
					message={t("git.branchSwitcherConfirmMessage", { branch: pendingBranch })}
					confirmLabel={t("git.branchSwitcherConfirmLabel")}
					onConfirm={() => {
						props.onSwitchBranch(pendingBranch);
						setPendingBranch(null);
					}}
					onCancel={() => setPendingBranch(null)}
				/>
			)}
		</>
	);
}

export function ComposerBottomBar(props: {
	sessionId: string;
	state?: AgentRuntimeState;
	disabled?: boolean;
	/** 思考入口由本栏偏好 owner 注入，与模型弹框和快捷键共用档位/保存链路。 */
	thinkingControl: ReactNode;
	/** 分支切换专用禁用：agent 运行中保持锁定（切分支会真的改动工作区文件，
	 *  正在跑的代码被换掉有风险）；「+」菜单等草稿/下一轮配置类入口不跟随此锁。 */
	branchDisabled?: boolean;
	/** 模型按钮专用禁用：仅启动中禁用；运行中优先直接交给后端，busy 时才排到下一轮。 */
	modelDisabled?: boolean;
	/** 生成进行中已选定、本轮结束后才套到 Agent 的模型（显示为 from→to）。 */
	modelPending?: ModelPending;
	composerAgentMode: ComposerAgentMode;
	gitInfo?: GitBranchInfo;
	/** 切换分支（右侧分支下拉）：经栏级 usePaneGitInfo 的 switchBranch 执行，
	 *  成功后回写本栏 gitInfo 并通知 App（仅当本栏为聚焦项目时采纳），右侧 Git 面板与底栏保持同步。 */
	onSwitchBranch?: (branch: string) => void;
	/** Draft sessions do not have a runtime yet, so retain their persisted settings in the bar. */
	record?: Pick<SessionRecord, "model" | "thinkingLevel">;
	/** 引导页模型默认值仅在记录缺失时兑底，不覆盖会话已保存的选择。 */
	defaultModel?: { provider?: string; modelId?: string; modelName?: string };
	/** 当前会话后端（pi 缺省）。 */
	backend?: AgentBackend;
	/** 提示词增强域（hook 拥有状态，底栏只呈现）：缺省隐藏入口。 */
	enhance?: { view: PromptEnhanceView; start: () => void; cancel: () => void };
	/** 切换后端：UI 层面先停 runtime 再写 catalog；acp 可带工具 id（picker 两页式弹层内选定）。 */
	onChangeBackend?: (backend: AgentBackend, acpToolId?: string) => void;
	/** ACP 工具二级选择（仅 acp 后端渲染；激活后不传 onChange 即只读）。 */
	acpTool?: { toolId?: string; onChange?: (toolId: string) => void };
	/** ACP 会话配置选择器（configOptions 整表 + 下发回调；undefined=agent 未提供,隐藏）。 */
	acpConfig?: { options: import("../../../../shared/types/acp").AcpSessionConfigOption[]; onSet: (optionId: string, value: string | boolean) => void };
	feishuIndicator?: ReactNode;
	/** 安全等级选择器（自包含组件，注入到左下角工具组） */
	securityControl?: ReactNode;
	/** 快捷消息入口（自包含组件，摆在安全控制位右侧，符合「权限右边」的固定习惯） */
	quickMessagesControl?: ReactNode;
	voiceControls: ReactNode;
	sendControls: ReactNode;
	onPickModel: () => void;
	onPickPromptTemplate: () => void;
	onPickSkill: () => void;
	onCompact: () => void;
	/** 上下文超限且占用快照缺失时，提供独立的恢复压缩入口。 */
	overflowRecoveryTarget?: SessionRuntimeTarget;
	onOverflowRecovery?: (target: SessionRuntimeTarget) => void;
	onChangeMode: (mode: ComposerAgentMode) => void;
	/** 会话已有生图消息时锁定生图模式，下拉不可切走。 */
	imageGenLocked?: boolean;
	onCancelPlan: () => void;
	onAttachFile: () => void;
	/** 生图模式底栏参数；非 imagegen 时不传。凭据来自独立 imagegen.json。 */
	imageGenOptions?: {
		config: ImageGenConfigFile;
		providerId: string;
		modelId: string;
		size: string;
		outputFormat: string;
		watermark: boolean;
		onSelectionChange: (providerId: string, modelId: string) => void;
		onSizeChange: (size: string) => void;
		onOutputFormatChange: (format: string) => void;
		onWatermarkChange: (watermark: boolean) => void;
	};
	/** 生视频模式底栏参数；非 videogen 时不传。凭据来自独立 videogen.json。 */
	videoGenOptions?: {
		config: VideoGenConfigFile;
		providerId: string;
		modelId: string;
		resolution?: string;
		duration?: string;
		ratio?: string;
		onSelectionChange: (providerId: string, modelId: string) => void;
		onParamChange: (key: "resolution" | "duration" | "ratio", value: string | undefined) => void;
	};
}) {
	// 真实会话以 runtime / catalog record 为准；只有无 record 的引导页虚拟会话
	// 才读取 welcome localStorage。这样用户点选模型/思考档位后能立即看到结果，
	// 首次发送再由 App.ensureSessionForSend 把同一显式选择带入真实会话。
	// 该偏好可能指向已删除的模型（localStorage 残留，用户删除模型后底栏仍显示旧默认）：
	// 引导页（无 record）模型目录：后端各自的目录都要加载，才能对各自的点选做存在性
	// 校验（pi 读 models.json 列表，DSH 读 host catalog）。目录命中主进程全局缓存
	//（模型选择器同源），通常不会额外 fork pi。
	const isDsh = props.backend === "dsh";
	const needsWelcomeCatalog = !props.record;
	const { models: welcomeCatalogModels, report: welcomeCatalogReport } = useBackendModelCatalog({
		sessionId: props.sessionId,
		backend: isDsh ? "dsh" : "pi",
		enabled: needsWelcomeCatalog,
	});
	// 引导页点选按后端读各自的存储（issue #253）：DSH 的模型是 host route 名，
	// 存在 WELCOME_DSH_MODEL_KEY；读错会拿到 pi 的 model 去校验 DSH 目录（必然「失效」）。
	const welcomeModel = needsWelcomeCatalog ? (isDsh ? readWelcomeDshModelPreference()?.model : readWelcomeModelPreference()?.model) : undefined;
	const welcomeModelLost = isWelcomeModelLost(welcomeModel, welcomeCatalogModels);
	// 删除不可逆，走保守判定：只有「一次成功的完整加载」才具备判死资格。
	// 本组件不传 projectId → 目录恒为全局范围，与全局偏好的作用域一致。
	const clearWelcomePreference = shouldClearWelcomePreference({
		welcomeModel,
		models: welcomeCatalogModels,
		catalogLoaded: welcomeCatalogReport?.ok === true,
		catalogIsGlobal: true,
	});
	useEffect(() => {
		// 失效偏好只清一次：下次引导页不再默认已删除的模型（创建时主进程也会兜底丢弃）。
		if (clearWelcomePreference) {
			try {
				localStorage.removeItem(isDsh ? WELCOME_DSH_MODEL_KEY : WELCOME_MODEL_KEY);
			} catch {
				// localStorage 不可用时静默；展示层已忽略该偏好。
			}
		}
	}, [clearWelcomePreference, isDsh]);
	const effectiveWelcomeModel = welcomeModelLost ? undefined : welcomeModel;
	// 引导页（无 record）默认模型展示：与各后端创建时的真实套用同序（点选 > 默认）。
	// 规则收拢到 resolveGuideDisplayModel，与 ComposerPickerHost 共用一份，避免两侧各自演化。
	const guideDefaultModel = resolveGuideDisplayModel({
		isDsh,
		welcomeModel: effectiveWelcomeModel,
		defaultModel: props.defaultModel,
	});
	// 模型优先取会话记录或引导页默认。DSH 例外：记录缺 model 时用 host 会话投影的
	// 当前选择兜底（runtime.state 的 provider/modelId 来自 host modelSelection 投影）——
	// 否则会显示全局部署默认，看起来像「别的会话的模型也改了」。pi 不接 runtime：
	// 运行时状态是执行态，不能覆盖用户保存的选择。
	const liveModel = resolveComposerLiveModel({
		record: props.record?.model,
		runtime: isDsh && props.state ? { provider: props.state.provider, modelId: props.state.modelId, modelName: props.state.modelName } : undefined,
		fallback: guideDefaultModel,
	});
	// 用量查询链路随会话后端：DSH 会话走 dsh（$DSH_HOME 配置 + 凭据库），其余走 pi。
	// 圆球面板必须与 DSH 卡片/选择器同一 backend，否则查的是另一条 usage-probes.json。
	const isImageGenMode = props.composerAgentMode === "imagegen";
	const isVideoGenMode = props.composerAgentMode === "videogen";
	// 生图/生视频底栏的「媒体后端」判据：模式 or 后端任一命中。
	// 只按 mode 判会漏屏蔽引导页窗口——引导页没有 record，mode 由 record.backend 推导
	// （controller 的 mode 三态分支），选了生图/生视频后端时 mode 仍是 normal，
	// 于是权限（pi 安全等级 / DSH 权限预设）、飞书镜像、会话 LLM 模型 chip 全部照旧显示。
	const isMediaComposer = isImageGenMode || isVideoGenMode || props.backend === "imagegen" || props.backend === "videogen";
	// 模式 = 后端身份（生图/生视频后端）：mode 由 record.backend 推导，controller 的 setMode
	// 对这两个后端直接 return，退出×点了也不会生效（用户反馈「选中视频模式后没办法退出」）。
	// 此时退出要走后端选择器（未开始对话）或新建会话（已锁定），不摆一个点了没反应的按钮。
	const mediaModeIsBackend = props.backend === "imagegen" || props.backend === "videogen";
	// 模式可用性（plan/goal 扩展开关、ACP 无隐藏 agentMessage 通道、imagegen 仅 pi、imageGenLocked 锁定）
	// 仍由专用 hook 统一维护；入口在「+」菜单的模式分组，底栏只保留正在生效的特殊模式 chip。
	const { visibleModes, refreshAvailability } = useComposerModeAvailability({
		backend: props.backend,
		imageGenLocked: props.imageGenLocked,
		value: props.composerAgentMode,
		disabled: props.disabled,
		onChange: props.onChangeMode,
	});
	// 模式入口 = 「+」菜单分组：只列计划/目标，普通模式不作为可选项（普通 = 不在任何特殊模式）。
	// visibleModes 为空（生图/生视频会话、legacy 锁定、ACP 或 plan+goal 扩展都关）时整个分组不渲染。
	// 不再有「输入框功能显示」里的模式开关（2026-10 用户反馈那行多余）：入口恒显示，退出靠底栏 chip 的 ×。
	const specialModes = visibleModes.filter((mode) => mode === "plan" || mode === "goal");
	const modeSectionVisible = specialModes.length > 0;
	// chip 只在 plan/goal 出现，并排除两种「setMode 会直接 return」的情况：
	// imageGenLocked（legacy pi 生图会话）与 mediaModeIsBackend（生图/生视频后端）——
	// 那两种退出要走后端选择器或新建会话，摆一个点了没反应的按钮是上一轮的 bug。
	const chipMode: "plan" | "goal" | null = props.composerAgentMode === "plan" || props.composerAgentMode === "goal" ? props.composerAgentMode : null;
	const modelDisplay = computeModelDisplay(liveModel.modelId ? liveModel : undefined, props.modelPending);
	const modelFrom = modelDisplay.from;
	const modelTo = modelDisplay.to;
	const modelName = modelFrom?.modelName || modelFrom?.modelId;
	const modelLabel = modelName ? formatModelRef(modelFrom ?? { provider: "", modelId: "" }) : `${t("app.model")}: -`;
	// 锁定态只读后端标识：ACP 会话把工具名拼进 title/aria-label（与下拉触发器同一套品牌 logo）。
	// hook 必须无条件调用：写成 `props.backend === "acp" ? useAtomValue(...) : undefined` 会让
	// 「切到 ACP 后端」这次渲染比上一次多一个 hook，直接抛 React #310（渲染的 hook 数多于上次）。
	const acpTools = useAtomValue(acpToolsAtom);
	const lockedAcpTool = props.backend === "acp" ? acpTools.find((tool) => tool.id === props.acpTool?.toolId) : undefined;
	const modelPendingTitle = props.modelPending
		? t("app.modelPendingTitle", {
				from: formatModelRef(props.modelPending.from),
				to: formatModelRef(props.modelPending.to),
			})
		: undefined;
	// 底栏只承载当前状态和直接操作，快捷键说明留给设置页，避免再次挤压编辑器。
	// shrink-0：面板缩到最小时底栏不被输入区挤扁/挤出滚动条
	return (
		<div className="composer-bottom-bar min-h-10 shrink-0 border-t border-transparent px-2.5 py-2">
			<div className="composer-bottom-layout flex min-w-0 items-center gap-2">
				{/* 底栏统一节奏（2027-02 用户反馈「logo 大小、间隙不统一」）：所有图标控件 28×28 盒子（size-7）、
				图标字形 15px、控件间距 4px（gap-1）——左区、会话级开关组、右区共用同一套数值，
				不再出现「24px 盒子 + 2px 间距」与「28px 盒子 + 8px 间距」两种密度并存。 */}
				<div className="composer-bottom-left flex min-w-0 flex-nowrap items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
					{props.onChangeBackend ? (
						<>
							{/* picker 组内高亮当前工具（acpToolId），工具改选也走同一条后端切换链 */}
							<ComposerBackendPicker backend={props.backend ?? "pi"} acpToolId={props.acpTool?.toolId} disabled={props.disabled} onChangeBackend={props.onChangeBackend} />
						</>
					) : props.backend ? (
						/* 后端已锁定（已发出第一条消息：pi 文件、DSH session log 与生图/生视频历史格式互不相同，
						   中途切换会导致消息同步渲染不可靠）：只读标识，只显示官方 logo 不重复文字。
						   inline-flex 居中：span 默认 inline，svg 按 baseline 排会偏上，
						   与底栏其它按钮（flex 居中 15px 图标）水平不平齐。
						   点击时弹提示说明锁定原因与换后端的途径（新建会话）。 */
						<button
							type="button"
							className="composer-bar-btn backend inline-flex size-7 cursor-pointer items-center justify-center rounded-md p-0 text-control font-semibold text-foreground hover:bg-muted/60"
							title={lockedAcpTool ? `${lockedAcpTool.name} · ${t("session.backendLockedHint")}` : t("session.backendLockedHint")}
							aria-label={lockedAcpTool ? `${lockedAcpTool.name} · ${t("session.backendLockedHint")}` : t("session.backendLockedHint")}
							onClick={() => showNotice(t("session.backendLockedNotice"), 5000)}
						>
							{props.backend === "dsh" ? (
								<DshLogo className="size-[15px] shrink-0" />
							) : props.backend === "imagegen" ? (
								<ImageIcon className="size-[15px] shrink-0 text-muted-foreground" />
							) : props.backend === "videogen" ? (
								<Clapperboard className="size-[15px] shrink-0 text-muted-foreground" />
							) : props.backend === "acp" ? (
								<AcpToolMark acpToolId={props.acpTool?.toolId} className="size-[15px] shrink-0" />
							) : (
								<PiLogo className="size-[15px] shrink-0" />
							)}
						</button>
					) : null}
					{/* 竖线分界已按用户反馈整体去掉（历史那条线因 Separator 竖向 h-full 被压掉一直不可见，
					    修复后露出来反而多余）：左区只靠间距分组，不再摆分隔线。 */}
					{/* 特殊模式 chip（计划/目标）：底栏唯一的模式身份控件，同时就是退出按钮。
					    普通模式不渲染任何东西（旧的闪电图标按用户反馈去掉，普通态 = 没有 chip）；
					    进入模式走「+」菜单的模式分组；
					    hover / 键盘聚焦时 chip 左侧图标旋成带圈 ×，点击回普通模式，
					    与 ComposerArea 的 onCancelPlan 同一条 setMode("normal")。
					    AnimatePresence 管进出场：切模式时旧 chip 淡出、新 chip 弹入（reduced-motion 下静态）。 */}
					<AnimatePresence initial={false}>
						{chipMode ? <ComposerModeChip key={chipMode} mode={chipMode} label={t(MODE_SHORT_LABEL[chipMode] ?? MODE_LABEL[chipMode])} icon={modeGlyph(chipMode)} title={t(MODE_EXIT_LABEL[chipMode] ?? MODE_LABEL[chipMode])} disabled={props.disabled} onExit={props.onCancelPlan} /> : null}
					</AnimatePresence>
					{/* 「+」入口：附件/技能/提示词 + 模式分组（计划/目标）。 */}
					<DropdownMenu
						onOpenChange={(open) => {
							// 打开时刷新扩展开关可用性：设置页可能刚改过 plan/goal 扩展（与后端 picker 同一套即时效）
							if (open) void refreshAvailability();
						}}
					>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								data-testid="composer-add-menu"
								/* 与后端/模式触发器同族：菜单关闭时 Radix 把焦点还给触发器，Button 基底的 ring 会闪一圈
								   （2026-10 用户反馈过 focus 环闪）。这里用 bg 高亮代替 ring，指针用户不闪、键盘用户仍有焦点反馈。 */
								className="composer-bar-btn icon size-7 rounded-md text-foreground hover:bg-muted/60 focus-visible:border-transparent focus-visible:bg-muted/60 focus-visible:ring-0"
								aria-label={t("app.composerAddTitle")}
								title={t("app.composerAddTitle")}
								disabled={props.disabled}
							>
								<LayoutGrid size={15} strokeWidth={2} aria-hidden="true" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" sideOffset={4} className="min-w-44">
							{/* 生图模式用图片粘贴添加参考图，不需要文件选择器上传附件；生视频一期不支持参考素材，附件无落点，同样不提供上传 */}
							{!isMediaComposer && (
								<DropdownMenuItem onSelect={() => props.onAttachFile()}>
									<Paperclip size={14} strokeWidth={2} aria-hidden="true" />
									{t("app.composerAddAttach")}
								</DropdownMenuItem>
							)}
							<DropdownMenuItem onSelect={() => props.onPickSkill()}>
								<Sparkles size={14} strokeWidth={2} aria-hidden="true" />
								{t("app.composerAddSkill")}
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => props.onPickPromptTemplate()}>
								<FileText size={14} strokeWidth={2} aria-hidden="true" />
								{t("app.composerAddPrompt")}
							</DropdownMenuItem>
							{/* 模式入口（2026-10 从底栏常驻下拉收回「+」菜单）：只列计划/目标；
							    普通模式不是可选项——普通就是「不选任何特殊模式」，退出走底栏 chip 上的 ×。
							    当前项打勾，再点一次同样回到普通（与 chip 的 onCancelPlan 同一条 setMode("normal")）。 */}
							{modeSectionVisible ? (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuLabel>{t("app.composerAddMode")}</DropdownMenuLabel>
									{specialModes.map((mode) => {
										const active = props.composerAgentMode === mode;
										return (
											<DropdownMenuItem key={mode} data-picker-value={mode} title={t(MODE_DESC_LABEL[mode] ?? MODE_LABEL[mode])} onSelect={() => props.onChangeMode(active ? "normal" : mode)}>
												{modeGlyph(mode)}
												<span className="min-w-0 truncate">{t(MODE_SHORT_LABEL[mode] ?? MODE_LABEL[mode])}</span>
												{active ? <Check size={14} strokeWidth={2} className="ml-auto shrink-0 text-primary" aria-hidden="true" /> : null}
											</DropdownMenuItem>
										);
									})}
								</>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
					{/* 生图/生视频后端无 pi/DSH runtime：安全等级（pi 安全门）与 DSH 权限预设都对图片/视频生成无意义，
					   且 SecurityControl 按 backend 分发时没有 imagegen 分支会误显示成 pi 安全等级菜单；
					   飞书镜像把输入同步到 IM，生图/生视频的 prompt 不走会话 runtime；
					   快捷消息同理（正文是给对话模型的指令），四个控制位一起屏蔽。 */}
					{/* 会话级开关组（飞书/安全等级/快捷消息）：与左区其余控件同一套尺寸与间距
						（28px 盒子 + gap-1）；飞书触发器原本还带 8px 横向内边距（28px 盒子却宽 30px），
						已收掉（见 integrations.css），否则同样是图标按钮却比邻居宽一圈。 */}
					{isMediaComposer ? null : (
						<div className="flex shrink-0 items-center gap-1">
							{props.feishuIndicator}
							{props.securityControl}
							{props.quickMessagesControl}
						</div>
					)}
				</div>
				<div className={`composer-bottom-center flex min-w-0 flex-1 items-center justify-center gap-4${isImageGenMode || isVideoGenMode ? " overflow-x-auto overflow-y-hidden [scrollbar-width:none]" : " overflow-hidden"}`}>
					{isImageGenMode && props.imageGenOptions ? (
						<ComposerImageGenOptions
							config={props.imageGenOptions.config}
							providerId={props.imageGenOptions.providerId}
							modelId={props.imageGenOptions.modelId}
							size={props.imageGenOptions.size}
							outputFormat={props.imageGenOptions.outputFormat}
							watermark={props.imageGenOptions.watermark}
							disabled={props.disabled}
							onSelectionChange={props.imageGenOptions.onSelectionChange}
							onSizeChange={props.imageGenOptions.onSizeChange}
							onOutputFormatChange={props.imageGenOptions.onOutputFormatChange}
							onWatermarkChange={props.imageGenOptions.onWatermarkChange}
						/>
					) : null}
					{isVideoGenMode && props.videoGenOptions ? (
						<ComposerVideoGenOptions
							config={props.videoGenOptions.config}
							providerId={props.videoGenOptions.providerId}
							modelId={props.videoGenOptions.modelId}
							resolution={props.videoGenOptions.resolution}
							duration={props.videoGenOptions.duration}
							ratio={props.videoGenOptions.ratio}
							disabled={props.disabled}
							onSelectionChange={props.videoGenOptions.onSelectionChange}
							onParamChange={props.videoGenOptions.onParamChange}
						/>
					) : null}
					{/* 生图/生视频模式用独立供应商/模型下拉，不展示会话 LLM chip，避免两套配置混用。
					    ACP 同理：模型/思考由 agent CLI 自持（session/config options 或各自 /model 命令），
					    PiDeck 维护的 models.json 对 agent CLI 无意义，隐藏 chip 防止两套语义混用。 */}
					{isMediaComposer || props.backend === "acp" ? null : (
						<ModelThinkingChip modelLabel={modelLabel} modelPendingTo={modelDisplay.pending && modelTo ? modelTo.modelName || modelTo.modelId : undefined} modelPendingTitle={modelPendingTitle} disabled={props.modelDisabled ?? props.disabled} onPickModel={props.onPickModel} thinkingControl={props.thinkingControl} />
					)}
					{/* ACP：模型/思考档/模式选择器,枚举来自 agent 回传的 configOptions
					    （本尊清单,不手写防漂移）;agent 未提供时不渲染。 */}
					{props.backend === "acp" && props.acpConfig ? <AcpConfigControls options={props.acpConfig.options} disabled={props.disabled} onSet={props.acpConfig.onSet} /> : null}
					{/* DSH 压缩入口与 pi 统一：上下文圆环（右侧）常驻并带压缩按钮。
					    2026-12 兼容期：dsh runtime state 已由主进程提供 contextPercent 兜底
					    （request/context 的 contextWindow + 消息估算），圆环不再因缺数据隐藏，
					    原独立 compact 按钮移除，避免双入口。 */}
				</div>
				<div className="composer-bottom-right ml-auto flex shrink-0 items-center gap-1">
					{/* 分支只读 chip 升级为可切换下拉：当前分支即触发器，展开列表选目标分支后
					    先弹确认（切换会携带未提交更改），确认后才调栏级 switchBranch（绑定本栏项目）。 */}
					{props.gitInfo?.current && props.onSwitchBranch ? (
						<ComposerBranchSwitcher gitInfo={props.gitInfo} disabled={props.branchDisabled ?? props.disabled} onSwitchBranch={props.onSwitchBranch} />
					) : props.gitInfo?.current ? (
						<span
							className="composer-bar-branch inline-flex max-w-[12rem] items-center gap-1.5 truncate px-1.5 text-control font-medium text-muted-foreground"
							title={t("app.branchCurrent", {
								branch: props.gitInfo.current,
								count: props.gitInfo.branches.length,
							})}
						>
							<GitBranch size={15} strokeWidth={1.8} aria-hidden="true" />
							<span className="composer-bar-branch-name truncate">{props.gitInfo.current}</span>
						</span>
					) : null}
					{props.enhance ? <PromptEnhanceControls disabled={props.disabled} view={props.enhance.view} modelLabel={props.enhance.view.modelLabel} onStart={props.enhance.start} onCancel={props.enhance.cancel} /> : null}
					{props.voiceControls}
					{props.sendControls}
				</div>
			</div>
		</div>
	);
}

/**
 * 选择器对话框外壳（#115 U5 收尾）：统一 shadcn Dialog + cmdk Command，
 * 旧 Prompt 选择器仍使用统一 shadcn Dialog + cmdk；模型和引导页使用 CommandPickerPanel，共享折叠、搜索和选中项定位。
 * 保留此壳是为了支持 Prompt 预览态的特殊头部与返回操作。
 */
export function PickerDialog(props: { title: string; hint?: string; onClose: () => void; className?: string; children: ReactNode }) {
	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex max-h-[min(680px,calc(100vh-48px))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(560px,calc(100vw-48px))]", props.className)}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<div className="grid gap-0.5">
						<DialogTitle>{props.title}</DialogTitle>
						{props.hint && <small className="text-muted-foreground text-caption">{props.hint}</small>}
					</div>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
				{props.children}
			</DialogContent>
		</Dialog>
	);
}

/** Dialog wrapper for the shared Command panel; the panel owns header, search, groups, and footer. */
function CommandPickerDialog(props: {
	title: string;
	hint?: string;
	onClose: () => void;
	className?: string;
	searchPlaceholder?: string;
	emptyLabel?: ReactNode;
	value?: string;
	showGroupActions?: boolean;
	/** 默认展开的分组 id 集合（null = 默认全展开）；透传给 CommandPickerPanel。 */
	defaultExpandedIds?: ReadonlySet<string> | null;
	/** 搜索过滤函数；缺省用 cmdk 内置 fuzzy（仅模型选择器等长列表需要传精确子串过滤）。 */
	filter?: CommandPickerFilter;
	/** 标题栏操作（如模型列表手动刷新按钮）；渲染在折叠/展开按钮之后、关闭按钮之前 */
	headerAction?: ReactNode;
	children: ReactNode;
}) {
	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex max-h-[min(680px,calc(100vh-48px))] flex-col overflow-hidden p-0 sm:max-w-[min(560px,calc(100vw-48px))]", props.className)}>
				<CommandPickerPanel
					title={props.title}
					hint={props.hint}
					searchPlaceholder={props.searchPlaceholder ?? t("app.commandPickerSearch")}
					emptyLabel={props.emptyLabel ?? t("app.commandPickerEmpty")}
					value={props.value}
					showGroupActions={props.showGroupActions}
					defaultExpandedIds={props.defaultExpandedIds}
					filter={props.filter}
					headerAction={props.headerAction}
					onClose={props.onClose}
				>
					{props.children}
				</CommandPickerPanel>
			</DialogContent>
		</Dialog>
	);
}

/** 模型列表加载失败原因 → 引导文案（硬失败时替换通用空态，给出可操作动作）。 */
const MODEL_LIST_FAILURE_REASON_TEXT: Record<ModelListFailReason, TranslationKey> = {
	"pi-not-found": "app.modelListFailPiNotFound",
	"version-too-old": "app.modelListFailVersionTooOld",
	"config-invalid": "app.modelListFailConfigInvalid",
	"cli-failed": "app.modelListFailCliFailed",
	"waf-blocked": "app.modelListFailWafBlocked",
	"dsh-host-stopped": "app.modelListFailDshStopped",
	empty: "app.modelListFailEmpty",
};

/**
 * 模型列表为空时的引导块：按失败原因给出差异化建议（升级 pi / 修配置 / 配 pi 路径 / 添加模型），
 * 并附手动刷新入口（重新调用 pi --list-models）。
 * 「加载不出来」最常见两类根因：pi 版本过低（连 --list-models 都不认）与 models.json/auth.json
 * 配置损坏（CLI 与本地解析双双失败）——此前只显示"没有匹配的模型"，用户无从排查。
 */
function ModelListStatusGuide(props: { report: ModelListReport | null; refreshing?: boolean; onRefresh?: () => void }) {
	const report = props.report;
	if (!report) return null;
	const hardFailure = !report.ok && report.reason !== null;
	const textKey = hardFailure ? MODEL_LIST_FAILURE_REASON_TEXT[report.reason as ModelListFailReason] : "app.modelListEmptyGuide";
	return (
		<div className="flex flex-col items-start gap-2.5 px-4 py-5" role="alert">
			<div className="flex items-center gap-2 text-body font-semibold text-foreground">
				<AlertCircle size={15} className={hardFailure ? "text-destructive" : "text-muted-foreground"} aria-hidden="true" />
				{hardFailure ? t("app.modelListLoadFailed") : t("app.modelListEmptyTitle")}
			</div>
			<p className="text-caption leading-relaxed text-muted-foreground">{t(textKey)}</p>
			{report.detail && <pre className="max-h-28 w-full overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-muted/40 p-2.5 font-mono text-micro leading-relaxed text-muted-foreground">{report.detail}</pre>}
			{props.onRefresh && (
				<Button variant="outline" size="sm" className="mt-1" onClick={props.onRefresh} disabled={props.refreshing}>
					<RefreshCw size={13} className={props.refreshing ? "animate-pideck-spin" : ""} aria-hidden="true" />
					{props.refreshing ? t("app.modelPickerRefreshing") : t("app.modelPickerRetry")}
				</Button>
			)}
		</div>
	);
}

/**
 * 首次加载态：模型目录还没返回任何报告时的占位。
 * 旧实现在此状态下面板完全空白（models=[] 且 report=null 两个分支都不命中），
 * 用户以为「选择器里没有模型」；改为明确的加载提示。
 */
function ModelListLoadingState() {
	return (
		<div className="flex items-center gap-2.5 px-4 py-5 text-caption text-muted-foreground" role="status" aria-live="polite">
			<Loader2 size={15} className="animate-pideck-spin" aria-hidden="true" />
			{t("app.modelListLoading")}
		</div>
	);
}

export function ModelPicker(props: {
	models: AvailableModel[];
	current?: { provider?: string; modelId?: string; modelName?: string };
	onClose: () => void;
	onPick: (model: AvailableModel) => void;
	/** 仅引导页和未启动草稿可恢复默认模型解析。 */
	onClear?: () => void;
	/** 收藏的模型 ID 列表（格式：provider/modelId），收藏的模型独立置顶显示但仍保留在原供应商分组 */
	favoriteModels?: string[];
	/** 切换收藏状态；引导页不提供收藏操作，因此允许省略。 */
	onToggleFavorite?: (provider: string, modelId: string) => void;
	/** 模型列表加载报告：为空时（加载失败/无模型）展示原因引导（版本过低/配置损坏/pi 未安装等）。 */
	report?: ModelListReport | null;
	/** 首次加载在途：列表为空时展示加载态（与 report=null 配对使用） */
	loading?: boolean;
	/** 手动刷新进行中（重新调用 pi --list-models） */
	refreshing?: boolean;
	/** 手动刷新：绕过缓存重新拉取模型列表 */
	onRefresh?: () => void;
	/** 用量查询链路：DSH 会话（目录 provider 是 DSH route 名）传 "dsh"，缺省 pi。 */
	backend?: UsageProbeBackend;
	/** 最近使用的供应商 ID 列表（最新在前）：已用过的分组排最前，未用过的按内置置顶+字母序。 */
	recentProviders?: string[];
	/** 供应商自定义顺序（模型页排序结果，后端对应数组由宿主选择）：列出的严格按此展示且不再被最近使用覆盖。 */
	providerOrder?: string[];
	/** 用户隐藏的供应商 key 列表（Pi 模型页眼睛开关）；Pi 后端按 provider 过滤，DSH 不生效。 */
	hiddenProviders?: string[];
	/** 用户隐藏的模型列表（格式："provider/modelId"）；Pi 后端过滤单个模型。 */
	hiddenModels?: string[];
	/** 切换模型隐藏状态（可直接在模型选择器中隐藏模型，也可在折叠区恢复显示）。 */
	onToggleHideModel?: (provider: string, modelId: string) => void;
	/** 打开时展开所有供应商分组：用于「从全部模型里挑一个」的场景（如外部连接的模型优先级）。 */
	expandAllProviders?: boolean;
}) {
	const currentModelKey = props.current?.provider && props.current?.modelId ? `${props.current.provider}/${props.current.modelId}` : undefined;
	const favoritesSet = new Set(props.favoriteModels ?? []);
	// 隐藏开关：Pi 后端按 provider 与 model 过滤（DSH 的 route 名不参与隐藏列表）；
	// 过滤后收藏/分组/搜索都基于可见模型，隐藏供应商与隐藏模型不出现在主选择区。
	const hiddenProviderSet = new Set(props.backend === "dsh" ? [] : (props.hiddenProviders ?? []));
	const hiddenModelSet = new Set(props.backend === "dsh" ? [] : (props.hiddenModels ?? []));
	const visibleModels: AvailableModel[] = [];
	const hiddenModelList: AvailableModel[] = [];
	for (const model of props.models) {
		if (hiddenProviderSet.has(model.provider)) continue;
		const key = `${model.provider}/${model.id}`;
		if (hiddenModelSet.has(key)) {
			hiddenModelList.push(model);
		} else {
			visibleModels.push(model);
		}
	}

	// 收藏列表（从全部模型中提取，不移除原供应商分组下的显示）
	const favorites: AvailableModel[] = visibleModels.filter((model) => favoritesSet.has(`${model.provider}/${model.id}`));
	favorites.sort((a, b) => {
		const ap = a.provider ?? "";
		const bp = b.provider ?? "";
		if (ap !== bp) return ap.localeCompare(bp);
		return (a.name ?? a.id).localeCompare(b.name ?? b.id);
	});

	// 全量模型按供应商分组（收藏模型也保留在原分组）；
	// 搜索交给 cmdk（item 的 value/keywords 同时覆盖 name/id/provider）
	const groupedModels = groupModelsByProvider(visibleModels);
	// 供应商分组顺序：用户自定义顺序优先（严格按拖拽结果），其余仍按最近使用 → 内置置顶 → 字母序；
	// 'other' 是白名单外供应商的兜底组，顺序保持最后。
	const sortedProviders = orderProviderGroups(Object.keys(groupedModels), props.recentProviders, props.providerOrder);

	// 默认展开集合（「当前选中模型可见」驱动）：只展开收藏栏 + 当前模型所在提供商，
	// 其余提供商折叠；无收藏且无当前模型时回退第一个提供商。折叠是派生状态，
	// 模型目录/收藏异步到达后，未覆盖的分组会自动按新集合生效，不再有“打开时全展开”的时序问题。
	const defaultExpandedIds = new Set(
		computeModelPickerDefaultExpanded({
			favorites,
			current: props.current,
			providers: sortedProviders,
			expandAll: props.expandAllProviders,
		}),
	);
	// 主体状态：加载中 / 失败或空态引导 / 模型列表（纯函数，见 sessionPickerOptions）。
	const bodyState = resolveModelPickerBody({
		modelCount: props.models.length,
		report: props.report,
		loading: props.loading,
	});

	// 供应商用量行（cc-switch inline）：打开选择器时批量 TTL 去重查询，供应商标题行右侧
	// 显示彩色剩余/百分比；查不到（未启用/不支持/失败/查询中）的分组保持干净不渲染。
	// backend 按会话后端透传（DSH 目录的 provider 是 route 名，配置/凭据在 dsh 链路）。
	const batchRefreshUsage = useProviderUsageBatchRefresh();
	const providerKey = sortedProviders.join("\n");
	useEffect(() => {
		if (providerKey) batchRefreshUsage(providerKey.split("\n"), props.backend);
	}, [providerKey, batchRefreshUsage, props.backend]);

	const renderModelRow = (model: AvailableModel, valueOverride?: string) => {
		const modelKey = `${model.provider}/${model.id}`;
		const selected = modelKey === currentModelKey;
		const favorited = favoritesSet.has(modelKey);
		// cmdk 用 CommandItem.value 作为选中态标识；同一模型在收藏栏和普通提供商
		// 分组各渲染一行时，value 必须唯一，否则鼠标悬停/键盘选中会让两行同时高亮。
		// data-picker-value 仍保留模型 key，供面板“当前模型滚动定位”使用。
		const itemValue = valueOverride ?? modelKey;
		// 行文案：provider/名称，单行（原双行「name + provider/id」视觉太重，id 收进 tooltip）。
		const labels = modelRowLabel(model);
		return (
			<CommandItem key={itemValue} value={itemValue} data-picker-value={modelKey} keywords={[model.name ?? "", model.id, model.provider, modelKey]} onSelect={() => props.onPick(model)} className="group min-h-9 items-center gap-2 rounded-md px-2.5 py-1">
				{/* 收藏/取消收藏按钮：填充星为收藏，空心为未收藏 */}
				{props.onToggleFavorite && (
					<button
						type="button"
						className={`grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground${favorited ? " text-amber-500" : ""}`}
						title={favorited ? t("app.modelUnfavorite") : t("app.modelFavorite")}
						aria-label={favorited ? t("app.modelUnfavorite") : t("app.modelFavorite")}
						onClick={(e) => {
							e.stopPropagation();
							props.onToggleFavorite?.(model.provider, model.id);
						}}
					>
						<Star size={14} strokeWidth={1.8} fill={favorited ? "currentColor" : "none"} />
					</button>
				)}
				<span className="min-w-0 flex-1 truncate font-mono text-control font-medium text-foreground" title={`${modelRowName(model)} · ${modelKey}`}>
					{labels}
				</span>
				{/* 隐藏模型操作按钮：悬停时显示，点击将模型放入隐藏列表 */}
				{props.onToggleHideModel && !favorited && (
					<button
						type="button"
						className="invisible grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-60 transition-colors hover:bg-accent hover:text-foreground hover:opacity-100 group-hover:visible"
						title={t("app.modelHide")}
						aria-label={t("app.modelHide")}
						onClick={(e) => {
							e.stopPropagation();
							props.onToggleHideModel?.(model.provider, model.id);
						}}
					>
						<EyeOff size={13} strokeWidth={1.8} />
					</button>
				)}
				{selected ? <Check size={15} className="ml-auto shrink-0 text-primary" aria-hidden="true" /> : null}
			</CommandItem>
		);
	};

	return (
		<CommandPickerDialog
			title={t("app.modelPickerTitle")}
			onClose={props.onClose}
			className="model-picker sm:max-w-[min(720px,calc(100vw-32px))]"
			searchPlaceholder={t("app.modelPickerSearch")}
			emptyLabel={t("app.modelPickerEmpty")}
			value={currentModelKey}
			showGroupActions
			defaultExpandedIds={defaultExpandedIds}
			// 精确子串搜索：cmdk 默认 fuzzy 会让 1-2 字符词命中全部 tokendance 模型（见
			// modelPickerSearchFilter 注释）；其他选择器（思考级别/预设）仍用默认 fuzzy。
			filter={modelPickerSearchFilter}
			// 手动刷新入口：标题栏右上角，任何情况下（含加载失败）都能重新拉取模型列表。
			headerAction={
				<>
					{props.onClear && (
						<Button variant="ghost" size="sm" className="h-7 text-caption" onClick={props.onClear} title={t("app.modelClearSelectionHint")}>
							{t("app.modelClearSelection")}
						</Button>
					)}
					{props.onRefresh && (
						<Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" aria-label={t("app.modelPickerRefresh")} title={props.refreshing ? t("app.modelPickerRefreshing") : t("app.modelPickerRefresh")} onClick={props.onRefresh} disabled={props.refreshing}>
							<RefreshCw size={14} className={props.refreshing ? "animate-pideck-spin" : ""} aria-hidden="true" />
						</Button>
					)}
				</>
			}
		>
			{bodyState === "loading" ? (
				<ModelListLoadingState />
			) : bodyState === "guide" && props.report ? (
				<ModelListStatusGuide report={props.report} refreshing={props.refreshing} onRefresh={props.onRefresh} />
			) : (
				<>
					{favorites.length > 0 && (
						<CommandPickerGroup id="favorites" label={t("app.modelFavorites")} count={favorites.length} countText={t("config.count.models", { count: favorites.length })}>
							{favorites.map((model) => renderModelRow(model, `favorites/${model.provider}/${model.id}`))}
						</CommandPickerGroup>
					)}
					{sortedProviders.map((provider) => (
						<CommandPickerGroup id={`provider:${provider}`} key={provider} label={provider} count={groupedModels[provider].length} countText={t("config.count.models", { count: groupedModels[provider].length })} trailing={<ProviderUsageInline provider={provider} variant="row" backend={props.backend} />}>
							{groupedModels[provider].map((model) => renderModelRow(model))}
						</CommandPickerGroup>
					))}
					{hiddenModelList.length > 0 && props.onToggleHideModel && (
						<CommandPickerGroup id="hidden-models" label={t("app.modelHiddenSection")} count={hiddenModelList.length} countText={t("config.count.models", { count: hiddenModelList.length })}>
							{hiddenModelList.map((model) => {
								const modelKey = `${model.provider}/${model.id}`;
								// 与可见行同一套文案规则（provider/名称，单行），只是整体弱化显示。
								const labels = modelRowLabel(model);
								return (
									<CommandItem key={`hidden/${modelKey}`} value={`hidden/${modelKey}`} data-picker-value={modelKey} keywords={[model.name ?? "", model.id, model.provider, modelKey]} className="group min-h-9 items-center gap-2 rounded-md px-2.5 py-1 text-muted-foreground" onSelect={() => props.onPick(model)}>
										<span className="min-w-0 flex-1 truncate font-mono text-control opacity-70" title={`${modelRowName(model)} · ${modelKey}`}>
											{labels}
										</span>
										<button
											type="button"
											className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
											title={t("app.modelHiddenRestore")}
											aria-label={t("app.modelHiddenRestore")}
											onClick={(e) => {
												e.stopPropagation();
												props.onToggleHideModel?.(model.provider, model.id);
											}}
										>
											<Eye size={14} strokeWidth={1.8} />
										</button>
									</CommandItem>
								);
							})}
						</CommandPickerGroup>
					)}
				</>
			)}
		</CommandPickerDialog>
	);
}

/**
 * Prompt Template 选择器：列出 ~/.pi/agent/prompts/ 下所有 .md 模板，
 * 点击后将模板内容插入到 composer 输入框。
 */
export function PromptTemplatePicker(props: {
	templates: Array<{
		name: string;
		path: string;
		description: string;
		content: string;
		scope?: "global" | "project";
		argumentHint?: string;
	}>;
	onClose: () => void;
	onPick: (template: { name: string; path: string; description: string; content: string; scope?: "global" | "project"; argumentHint?: string }) => void;
	/** 一键插入模板全文到输入框（可选：ComposerPickerHost 传 controller 方法）。 */
	onInsertContent?: (template: { name: string; path: string; description: string; content: string; scope?: "global" | "project"; argumentHint?: string }) => void;
}) {
	type TemplateItem = (typeof props.templates)[number];
	const [previewTemplate, setPreviewTemplate] = useState<TemplateItem | null>(null);

	// 预览态：替换标题为返回按钮 + 模板名，正文为模板内容（沿用旧内联预览设计）
	if (previewTemplate) {
		return (
			<PickerDialog title={t("app.promptTemplatePreviewTitle", { name: "/" + previewTemplate.name })} onClose={props.onClose} className="prompt-template-picker">
				<div className="picker-preview-inline">
					<div className="flex items-center justify-between gap-2">
						<Button type="button" variant="ghost" className="h-auto gap-1 px-1 text-caption" onClick={() => setPreviewTemplate(null)} title={t("app.promptTemplateBackToPicker")}>
							<ChevronLeft size={16} strokeWidth={2.2} />
							{t("app.promptTemplateBackToPicker")}
						</Button>
						{/* 预览里同样可以一键插入全文（与条目上的插入按钮入口并列） */}
						{props.onInsertContent && (
							<Button type="button" variant="outline" size="sm" className="h-7 gap-1" onClick={() => props.onInsertContent?.(previewTemplate)} title={t("app.pickerInsertContent")}>
								<CornerDownLeft size={13} strokeWidth={2} aria-hidden="true" />
								{t("app.pickerInsertContent")}
							</Button>
						)}
					</div>
					<pre className="picker-preview-content">{previewTemplate.content}</pre>
				</div>
			</PickerDialog>
		);
	}

	return (
		/* 与技能/模型选择器对齐（#115 之后的双行卡片式条目）：
		   首行图标 + 斜杠命令名 + 参数提示徽标，次行截断的描述；
		   预览按钮保留（查看模板正文）。旧 picker-palette-* 单行挤排版弃用。 */
		<PickerDialog title={t("app.promptTemplatePickerTitle")} hint={t("app.pickerInsertSendHint")} onClose={props.onClose} className="prompt-template-picker">
			<Command>
				<CommandInput placeholder={t("app.promptTemplateSearchPlaceholder")} autoFocus />
				<CommandList className="max-h-[min(420px,55vh)]">
					<CommandEmpty>{t("app.promptTemplateSearchEmpty")}</CommandEmpty>
					{props.templates.length === 0 && <div className="px-6 py-10 text-center text-caption text-muted-foreground">{t("app.promptTemplateEmpty")}</div>}
					{props.templates.map((template) => (
						// key 用 name+path：包带模板（来源 B）没有可编辑路径，path 恒为空，单用 path 会撞 key
						<CommandItem key={`${template.name}:${template.path}`} value={`/${template.name}`} keywords={[template.name, template.description, template.argumentHint ?? ""]} onSelect={() => props.onPick(template)} className="group min-h-10 items-center gap-2.5 rounded-md px-3 py-2">
							<span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/70 text-muted-foreground">
								<FileText size={14} strokeWidth={1.8} aria-hidden="true" />
							</span>
							<span className="min-w-0 flex-1">
								<span className="flex items-center gap-1.5">
									<span className="font-mono text-control font-semibold text-foreground" title={`/${template.name}`}>
										/{template.name}
									</span>
									{template.argumentHint && <code className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-micro text-accent-foreground">{template.argumentHint}</code>}
								</span>
								{template.description && (
									<span className="mt-0.5 block truncate text-caption text-muted-foreground" title={template.description}>
										{template.description}
									</span>
								)}
							</span>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								title={t("common.preview")}
								onClick={(e) => {
									e.stopPropagation();
									setPreviewTemplate(template);
								}}
							>
								<Eye size={14} strokeWidth={1.8} aria-hidden="true" />
							</Button>
							{/* 一键插入全文：把模板内容整段塞进输入框（不生成斜线命令），
							    与 onPick（插入 /名称 命令）是并列入口，两者由用户视需要选择。 */}
							{props.onInsertContent && (
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									title={t("app.pickerInsertContent")}
									onClick={(e) => {
										e.stopPropagation();
										props.onInsertContent?.(template);
									}}
								>
									<CornerDownLeft size={14} strokeWidth={1.8} aria-hidden="true" />
								</Button>
							)}
						</CommandItem>
					))}
				</CommandList>
			</Command>
		</PickerDialog>
	);
}
