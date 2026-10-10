import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { dshModuleHiddenAtom, imageGenModuleHiddenAtom, composerModesHiddenAtom, acpEnabledAtom, acpToolsAtom } from "../../atoms";
import { AlertCircle, BrainCircuit, Check, ChevronDown, ChevronLeft, ChevronRight, CornerDownLeft, Eye, EyeOff, FileText, GitBranch, ImageIcon, ListChecks, Loader2, Paperclip, Plus, RefreshCw, Settings2, Sparkles, Star, Target, Terminal, Wrench, X } from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import type { PromptEnhanceView } from "../../hooks/usePromptEnhance";
import { PromptEnhanceControls } from "./PromptEnhanceControls";
import { Button } from "../ui-shadcn/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "../ui-shadcn/command";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { cn } from "../../lib/utils";
import { showNotice } from "../../utils/notice";
import { ModelThinkingChip } from "./ModelThinkingChip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { ConfirmDialog } from "../app/AppParts";
import { ComposerImageGenOptions } from "./ComposerImageGenOptions";
import { useComposerModeAvailability } from "../../hooks/useComposerModeAvailability";
import type { ImageGenConfigFile } from "../../../../shared/imageGenConfig";
import { ProviderUsageInline } from "../app/ProviderUsageInline";
import { useProviderUsageBatchRefresh } from "../../hooks/useProviderUsage";
import { DshLogo, PiLogo } from "./SessionSourceBadge";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "../ui-shadcn/select";
import { computeModelDisplay, formatModelRef, resolveComposerLiveModel, resolveGuideDisplayModel, type ModelPending } from "../../utils/modelPendingDisplay";
import { WELCOME_DSH_MODEL_KEY, WELCOME_MODEL_KEY, isWelcomeModelLost, readWelcomeDshModelPreference, readWelcomeModelPreference, shouldClearWelcomePreference } from "../../utils/chatSessionBootstrap";
import { useBackendModelCatalog } from "../../hooks/useBackendModelCatalog";
import { CommandPickerGroup, CommandPickerPanel, type CommandPickerFilter } from "../ui-shadcn/command-picker";
import { computeModelPickerDefaultExpanded, groupModelsByProvider, modelPickerSearchFilter, modelRowLabel, modelRowName, orderProviderGroups, resolveModelPickerBody } from "./sessionPickerOptions";
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
};

/** 模式图标：普通=扳手，规划=清单，目标=靶心，生图=图片（与旧 chip 图标一致）。 */
function modeGlyph(mode: ComposerAgentMode) {
	if (mode === "plan") return <ListChecks size={14} strokeWidth={2} aria-hidden="true" />;
	if (mode === "imagegen") return <ImageIcon size={14} strokeWidth={2} aria-hidden="true" />;
	if (mode === "goal") return <Target size={14} strokeWidth={2} aria-hidden="true" />;
	return <Wrench size={14} strokeWidth={2} aria-hidden="true" />;
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
			{expanded && (
				<div className="extension-widget-card-content">
					{props.lines.map((line, index) => (
						<div key={index} className="extension-widget-card-line">
							{renderWidgetLine(line)}
						</div>
					))}
				</div>
			)}
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
						className="composer-bar-btn backend h-7 gap-1 rounded-md border-transparent px-1.5 text-control font-semibold text-foreground hover:bg-muted/60 focus-visible:border-transparent focus-visible:ring-0 data-[state=open]:border-transparent data-[state=open]:ring-0 max-w-44 [&_[data-slot='select-icon']]:hidden"
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

export function ComposerBackendPicker(props: { backend: AgentBackend; acpToolId?: string; disabled?: boolean; onChangeBackend: (backend: AgentBackend, acpToolId?: string) => void }) {
	const dshHidden = useAtomValue(dshModuleHiddenAtom);
	const imageGenHidden = useAtomValue(imageGenModuleHiddenAtom);
	// ACP 是 opt-in：开关开启且登记了工具才列入口；已是 acp 会话时始终保留
	//（同 dsh/imagegen 的「+当前后端」规则，避免切走后回不来）。
	const acpEnabled = useAtomValue(acpEnabledAtom);
	const acpTools = useAtomValue(acpToolsAtom);
	const showAcp = (acpEnabled && acpTools.length > 0) || props.backend === "acp";
	const showDsh = !dshHidden || props.backend === "dsh";
	const showImageGen = !imageGenHidden || props.backend === "imagegen";
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
				className="composer-bar-btn backend h-7 gap-1 rounded-md border-transparent px-1.5 text-control font-semibold text-foreground hover:bg-muted/60 focus-visible:border-transparent focus-visible:ring-0 data-[state=open]:border-transparent data-[state=open]:ring-0 [&_[data-slot='select-icon']]:hidden"
				title={t("session.backendPickerHint")}
			>
				{/* 不渲染 SelectValue：按当前后端手动渲染 logo，输入框只显示图标不带文字。
				    隐藏 shadcn SelectTrigger 自带的 chevron（[data-slot='select-icon']），
				    否则 logo 与 chevron 并排（justify-between）→ 图标偏左不居中、
				    16px chevron 与 14px logo 混排导致上下不齐。 */}
				{props.backend === "dsh" ? (
					<DshLogo className="size-[15px] shrink-0" />
				) : props.backend === "imagegen" ? (
					<ImageIcon className="size-[15px] shrink-0 text-muted-foreground" />
				) : props.backend === "acp" ? (
					<Terminal className="size-[15px] shrink-0 text-muted-foreground" />
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
								<Terminal className="size-3.5 shrink-0 text-muted-foreground" />
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
						className="composer-bar-btn branch h-7 max-w-[12rem] gap-1 rounded-md px-1.5 text-sm font-semibold text-foreground/75 hover:bg-muted/60"
						title={t("app.branchCurrent", {
							branch: props.gitInfo.current,
							count: props.gitInfo.branches.length,
						})}
					>
						<GitBranch size={14} strokeWidth={1.8} aria-hidden="true" />
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
	// 模型仅取会话记录或引导页默认，运行时快照不能覆盖用户已保存的选择。
	const liveModel = resolveComposerLiveModel({
		record: props.record?.model,
		fallback: guideDefaultModel,
	});
	// 用量查询链路随会话后端：DSH 会话走 dsh（$DSH_HOME 配置 + 凭据库），其余走 pi。
	// 圆球面板必须与 DSH 卡片/选择器同一 backend，否则查的是另一条 usage-probes.json。
	const isPlanMode = props.composerAgentMode === "plan";
	const isImageGenMode = props.composerAgentMode === "imagegen";
	const isGoalMode = props.composerAgentMode === "goal";
	const isSpecialMode = isPlanMode || isImageGenMode || isGoalMode;
	// 模式选择器常驻底栏（外移自「+」菜单，2026-10 用户要求直接可见）；可用性（plan/goal 扩展开关、
	// imagegen 仅 pi、imageGenLocked 锁定）由专用 hook 统一维护（原 ComposerModeSelect 逻辑）。
	const { visibleModes, refreshAvailability } = useComposerModeAvailability({
		backend: props.backend,
		imageGenLocked: props.imageGenLocked,
		value: props.composerAgentMode,
		disabled: props.disabled,
		onChange: props.onChangeMode,
	});
	// 设置 → 外观 → 功能模块可隐藏模式选择器；进行中的特殊模式仍由退出×兜底，不会锁死在 plan/goal。
	const modesHidden = useAtomValue(composerModesHiddenAtom);
	const modelDisplay = computeModelDisplay(liveModel.modelId ? liveModel : undefined, props.modelPending);
	const modelFrom = modelDisplay.from;
	const modelTo = modelDisplay.to;
	const modelName = modelFrom?.modelName || modelFrom?.modelId;
	const modelLabel = modelName ? formatModelRef(modelFrom ?? { provider: "", modelId: "" }) : `${t("app.model")}: -`;
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
				<div className="composer-bottom-left flex min-w-0 flex-nowrap items-center gap-0.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
					{props.onChangeBackend ? (
						<>
							{/* picker 组内高亮当前工具（acpToolId），工具改选也走同一条后端切换链 */}
							<ComposerBackendPicker backend={props.backend ?? "pi"} acpToolId={props.acpTool?.toolId} disabled={props.disabled} onChangeBackend={props.onChangeBackend} />
						</>
					) : props.backend ? (
						/* 后端已锁定（会话激活后不可切换：pi 文件与 DSH session log 格式不同，
						   中途切换会导致消息同步渲染不可靠）：只读标识，只显示官方 logo 不重复文字。
						   inline-flex 居中：span 默认 inline，svg 按 baseline 排会偏上，
						   与底栏其它按钮（flex 居中 15px 图标）水平不平齐。
						   用户输入时 Agent 可能已被自动启动、后端随之锁定，但用户不一定知情；
						   点击时弹提示说明锁定原因与换后端的途径（新建会话）。 */
						<button
							type="button"
							className="composer-bar-btn backend inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-control font-semibold text-foreground hover:bg-muted/60"
							title={t("session.backendLockedHint")}
							aria-label={t("session.backendLockedHint")}
							onClick={() => showNotice(t("session.backendLockedNotice"), 5000)}
						>
							{props.backend === "dsh" ? (
								<DshLogo className="size-[15px] shrink-0" />
							) : props.backend === "imagegen" ? (
								<ImageIcon className="size-[15px] shrink-0 text-muted-foreground" />
							) : props.backend === "acp" ? (
								<Terminal className="size-[15px] shrink-0 text-muted-foreground" />
							) : (
								<PiLogo className="size-[15px] shrink-0" />
							)}
						</button>
					) : null}
					{/* 特殊模式退出×：模式选择器已常驻底栏，这里是进行中模式的快捷退出
					    （imagegen 同样可退出；imageGenLocked 时无法切走故不显示；选择器被隐藏时它也是唯一逃生口）。 */}
					{isSpecialMode && !props.imageGenLocked && (
						<div className="composer-mode-cluster inline-flex h-7 min-w-0 items-center rounded-md bg-bg-hover pr-0.5">
							<button
								type="button"
								className="composer-mode-exit mr-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border-0 bg-transparent text-text-tertiary transition-[color,background-color] duration-fast hover:bg-bg-active hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
								aria-label={isGoalMode ? t("app.composerModeCancelGoal") : isImageGenMode ? t("app.composerModeCancelImagegen") : t("app.composerModeCancelPlan")}
								title={isGoalMode ? t("app.composerModeCancelGoal") : isImageGenMode ? t("app.composerModeCancelImagegen") : t("app.composerModeCancelPlan")}
								disabled={props.disabled}
								onClick={props.onCancelPlan}
							>
								<X size={12} strokeWidth={2} aria-hidden="true" />
							</button>
						</div>
					)}
					{/* 常驻模式选择器（外移自「+」菜单）：当前模式图标+名称直接可见可切；
					    visibleModes 为空（imagegen 会话/legacy 锁定）不渲染，走专用生图底栏；
					    hiddenModules 隐藏时收起入口（特殊模式仍可由上方退出×退出）；
					    打开时刷新扩展开关可用性（设置页可能刚改过 plan/goal 扩展）。 */}
					{/* 只剩 normal 一项（ACP 会话无 pi 扩展 / plan+goal 都被关）不渲染单选项下拉——
					    没有意义还占位；ACP 的模式等价物是 configOptions 的 mode 类选项（已由 AcpConfigControls 渲染）。打开时刷新扩展开关可用性（设置页可能刚改过 plan/goal 扩展）。 */}
					{visibleModes.length > 1 && !modesHidden ? (
						<Select
							value={props.composerAgentMode}
							disabled={props.disabled}
							onValueChange={(value) => props.onChangeMode(value as ComposerAgentMode)}
							onOpenChange={(open) => {
								// 打开时刷新扩展开关可用性：设置页可能刚改过 plan/goal 扩展（同后端 picker 的即时效）
								if (open) void refreshAvailability();
							}}
						>
							<SelectTrigger
								size="sm"
								className="composer-bar-btn h-7 gap-1 rounded-md border-transparent px-1.5 text-control font-semibold text-foreground hover:bg-muted/60 focus-visible:border-transparent focus-visible:ring-0 data-[state=open]:border-transparent data-[state=open]:ring-0"
								/* normal 模式只显图标（默认态不需要读字，用户反馈过）；特殊模式（计划/目标/生图）显文本提醒非默认态。
							    可访问性不降级：aria-label/title 始终携带当前模式全名，hover/读屏可读。菜单项保留文字便于扫读。 */
								aria-label={t(MODE_LABEL[props.composerAgentMode])}
								title={t(MODE_LABEL[props.composerAgentMode])}
							>
								{modeGlyph(props.composerAgentMode)}
								{props.composerAgentMode !== "normal" ? <span className="max-w-28 truncate">{t(MODE_LABEL[props.composerAgentMode])}</span> : null}
							</SelectTrigger>
							<SelectContent align="start">
								{visibleModes.map((mode) => (
									<SelectItem key={mode} value={mode}>
										{modeGlyph(mode)}
										{t(MODE_LABEL[mode])}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					) : null}
					{/* 「+」入口：附件/技能/提示词收起为单个菜单（模式已常驻底栏，不再入此菜单）。 */}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon" className="composer-bar-btn icon size-7 rounded-md text-foreground hover:bg-muted/60" aria-label={t("app.composerAddTitle")} title={t("app.composerAddTitle")} disabled={props.disabled}>
								<Plus size={15} strokeWidth={2} aria-hidden="true" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" sideOffset={4} className="min-w-44">
							{/* 生图模式用图片粘贴添加参考图，不需要文件选择器上传附件 */}
							{!isImageGenMode && (
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
						</DropdownMenuContent>
					</DropdownMenu>
					{props.feishuIndicator}
					{/* 生图模式无 pi/DSH runtime：安全等级（pi 安全门）与 DSH 权限预设都对图片生成无意义，
					   且 SecurityControl 按 backend 分发时没有 imagegen 分支会误显示成 pi 安全等级菜单；
					   快捷消息同理（正文是给对话模型的指令），两个控制位一起屏蔽。 */}
					{isImageGenMode ? null : (
						<>
							{props.securityControl}
							{props.quickMessagesControl}
						</>
					)}
				</div>
				<div className={`composer-bottom-center flex min-w-0 flex-1 items-center justify-center gap-4${isImageGenMode ? " overflow-x-auto overflow-y-hidden [scrollbar-width:none]" : " overflow-hidden"}`}>
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
					{/* 生图模式用独立供应商/模型下拉，不展示会话 LLM chip，避免两套配置混用。
					    ACP 同理：模型/思考由 agent CLI 自持（session/config options 或各自 /model 命令），
					    PiDeck 维护的 models.json 对 agent CLI 无意义，隐藏 chip 防止两套语义混用。 */}
					{isImageGenMode || props.backend === "acp" ? null : (
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
				<div className="composer-bottom-right ml-auto flex shrink-0 items-center gap-2">
					{/* 分支只读 chip 升级为可切换下拉：当前分支即触发器，展开列表选目标分支后
					    先弹确认（切换会携带未提交更改），确认后才调栏级 switchBranch（绑定本栏项目）。 */}
					{props.gitInfo?.current && props.onSwitchBranch ? (
						<ComposerBranchSwitcher gitInfo={props.gitInfo} disabled={props.branchDisabled ?? props.disabled} onSwitchBranch={props.onSwitchBranch} />
					) : props.gitInfo?.current ? (
						<span
							className="composer-bar-branch inline-flex max-w-[12rem] items-center gap-1.5 truncate px-1.5 text-sm font-semibold text-foreground/75"
							title={t("app.branchCurrent", {
								branch: props.gitInfo.current,
								count: props.gitInfo.branches.length,
							})}
						>
							<GitBranch size={14} strokeWidth={1.8} aria-hidden="true" />
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
						<CommandItem key={template.path} value={`/${template.name}`} keywords={[template.name, template.description, template.argumentHint ?? ""]} onSelect={() => props.onPick(template)} className="group min-h-10 items-center gap-2.5 rounded-md px-3 py-2">
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
