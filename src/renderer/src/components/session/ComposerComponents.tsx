import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import {
	Check,
	ChevronDown,
	ChevronLeft,
	Eye,
	FileText,
	FoldVertical,
	GitBranch,
	ListChecks,
	Paperclip,
	Star,
	Wrench,
	X,
} from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "../ui-shadcn/command";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import { cn } from "../../lib/utils";
import { CommandPickerGroup, CommandPickerPanel } from "../ui-shadcn/command-picker";
import { THINKING_LEVELS, groupModelsByProvider } from "./sessionPickerOptions";
import type {
	AgentRuntimeState,
	AvailableModel,
	ComposerAgentMode,
	GitBranchInfo,
	SessionRecord,
} from "../../../../shared/types";


/** 单个 extension widget 卡片：可折叠标题栏 + 内容行，支持手动关闭 */
// widgetKey 由扩展定义且跨重启稳定,可按 widgetKey 持久化折叠状态。
const EXTENSION_WIDGET_COLLAPSED_KEY_PREFIX =
	"pid:extension-widget-collapsed:";

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
	const storageKey = props.sessionIdOrPath
		? `${EXTENSION_WIDGET_COLLAPSED_KEY_PREFIX}${props.sessionIdOrPath}:${props.widgetKey}`
		: `${EXTENSION_WIDGET_COLLAPSED_KEY_PREFIX}${props.widgetKey}`;
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
				<button
					className="extension-widget-card-trigger"
					onClick={handleToggleExpanded}
					aria-expanded={expanded}
				>
					<ChevronDown
						size={14}
						className={`extension-widget-card-chevron${expanded ? " open" : ""}`}
					/>
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

export function ComposerBottomBar(props: {
	state?: AgentRuntimeState;
	compacting: boolean;
	disabled?: boolean;
	composerAgentMode: ComposerAgentMode;
	gitInfo?: GitBranchInfo;
	/** Draft sessions do not have a runtime yet, so retain their persisted settings in the bar. */
	record?: Pick<SessionRecord, "model" | "thinkingLevel">;
	feishuIndicator?: ReactNode;
	sendControls: ReactNode;
	onPickModel: () => void;
	onPickPromptTemplate: () => void;
	onPickThinking: () => void;
	onCompact: () => void;
	onOpenComposerModePicker: () => void;
	onCancelPlan: () => void;
	onAttachFile: () => void;
}) {
	const ctxPercent = props.state?.contextPercent;
	const showCompact = ctxPercent != null && ctxPercent > 30;
	const contextPercent = ctxPercent ?? 0;
	// 默认模型/思考级别来自主进程按 pi 配置自动填充进会话记录的默认值（props.record），
	// 不读取渲染层 welcome localStorage 偏好，避免用户偏好覆盖 pi 配置。
	const currentThinkingLevel = props.state?.thinkingLevel ?? props.record?.thinkingLevel;
	const thinkingLevelLabel = currentThinkingLevel
		? THINKING_LEVELS.find((level) => level.value === currentThinkingLevel)?.labelKey
		: undefined;
	const thinkingDisplay = thinkingLevelLabel
		? t(thinkingLevelLabel)
		: currentThinkingLevel ?? t("app.think");
	const isPlanMode = props.composerAgentMode === "plan";
	const modeLabel = isPlanMode
		? t("app.composerModePlan")
		: t("app.composerModeNormal");
	const modelProvider = props.state?.provider ?? props.record?.model?.provider;
	const modelName = props.state?.modelName ?? props.record?.model?.modelId;
	const modelLabel = modelName
		? `${modelProvider ? `${modelProvider}/` : ""}${modelName}`
		: `${t("app.model")}: -`;
	// 底栏只承载当前状态和直接操作，快捷键说明留给设置页，避免再次挤压编辑器。
	// shrink-0：面板缩到最小时底栏不被输入区挤扁/挤出滚动条
	return (
		<div className="composer-bottom-bar min-h-10 shrink-0 border-t border-border/40 px-2 py-1.5">
			<div className="composer-bottom-layout flex min-w-0 items-center gap-2">
				<div className="composer-bottom-left flex min-w-0 flex-wrap items-center gap-0.5">
					<Button
						variant="ghost"
						size="sm"
						className={`composer-bar-btn h-7 gap-1 rounded-md px-1.5 text-control font-semibold text-foreground hover:bg-muted/60${isPlanMode ? " active" : ""}`}
						disabled={props.disabled}
						onClick={props.onOpenComposerModePicker}
						aria-haspopup="dialog"
						title={t("app.composerModeTitle")}
					>
						{isPlanMode ? (
							<ListChecks size={15} strokeWidth={2} aria-hidden="true" />
						) : (
							<Wrench size={15} strokeWidth={2} aria-hidden="true" />
						)}
						<span>{modeLabel}</span>
					</Button>
					{isPlanMode && (
						<Button variant="ghost" size="icon"
							className="composer-bar-btn icon mode-cancel size-7 rounded-md"
							aria-label={t("app.composerModeCancelPlan")} title={t("app.composerModeCancelPlan")}
							disabled={props.disabled}
							onClick={props.onCancelPlan}
						>
							<X size={14} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					)}
					<Button variant="ghost" size="icon"
						className="composer-bar-btn icon size-7 rounded-md text-foreground hover:bg-muted/60"
						aria-label={t("app.promptTemplatePickerTitle")} title={t("app.promptTemplatePickerTitle")}
						disabled={props.disabled}
						onClick={props.onPickPromptTemplate}
					>
						<FileText size={15} strokeWidth={2} aria-hidden="true" />
					</Button>
					<Button variant="ghost" size="icon"
						className="composer-bar-btn icon size-7 rounded-md text-foreground hover:bg-muted/60"
						aria-label={t("menu.attachFile")} title={t("menu.attachFile")}
						disabled={props.disabled}
						onClick={props.onAttachFile}
					>
						<Paperclip size={15} strokeWidth={2} aria-hidden="true" />
					</Button>
					{props.feishuIndicator}
				</div>
				<div className="composer-bottom-center flex min-w-0 flex-1 items-center justify-center gap-4 overflow-hidden">
					<Button
						variant="ghost"
						size="sm"
						className="composer-bar-btn model flex h-7 min-w-0 max-w-[42ch] truncate rounded-md px-2 font-brand text-caption font-medium italic text-muted-foreground hover:bg-muted/60 hover:text-foreground"
						disabled={props.disabled}
						onClick={props.onPickModel}
						aria-haspopup="dialog"
						title={t("app.modelPickerTitle")}
					>
						{modelName ? (
							<>
								{modelProvider && (
									<span className="max-w-[14ch] truncate text-muted-foreground">{modelProvider}</span>
								)}
								{modelProvider && <span className="text-muted-foreground/50">/</span>}
								<span className="min-w-0 truncate">{modelName}</span>
							</>
						) : (
							<span className="text-muted-foreground">{modelLabel}</span>
						)}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						className="composer-bar-btn thinking h-7 max-w-[10rem] rounded-md px-2 font-brand text-caption font-semibold italic text-[var(--color-brand-green)] hover:bg-muted/60"
						disabled={props.disabled}
						onClick={props.onPickThinking}
						aria-haspopup="dialog"
						title={t("app.thinkingPickerTitle")}
					>
						{thinkingDisplay}
					</Button>
					{showCompact && (() => {
						// 与 main 一致：>30% 才显示；70%/90% 用色阶提示紧迫度，不做成常驻高饱和按钮。
						const isCompactingNow = Boolean(props.state?.isCompacting || props.compacting);
						const urgency =
							contextPercent >= 90 ? " critical" : contextPercent >= 70 ? " warn" : "";
						return (
							<Button
								variant="ghost"
								size="sm"
								className={`composer-bar-btn compact h-7 gap-1 rounded-md px-1.5 text-control${urgency}${isCompactingNow ? " compacting" : ""}`}
								disabled={
									isCompactingNow ||
									Boolean(props.state?.isStreaming)
								}
								title={t("app.contextCompactTitle", {
									percent: contextPercent.toFixed(1),
								})}
								aria-label={t("app.compact")}
								onClick={props.onCompact}
							>
								<FoldVertical size={13} strokeWidth={1.8} aria-hidden="true" />
								{isCompactingNow
									? t("app.compacting")
									: t("app.compactUsage", { percent: contextPercent.toFixed(0) })}
							</Button>
						);
					})()}
				</div>
				<div className="composer-bottom-right ml-auto flex shrink-0 items-center gap-2">
					{props.gitInfo?.current && (
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
					)}
					{props.sendControls}
				</div>
			</div>
		</div>
	);
}

/**
 * 选择器对话框外壳（#115 U5 收尾）：统一 shadcn Dialog + cmdk Command，
 * 旧 Prompt 选择器仍使用统一 shadcn Dialog + cmdk；模型、思考级别和引导页使用 CommandPickerPanel，共享折叠、搜索和选中项定位。
 * 保留此壳是为了支持 Prompt 预览态的特殊头部与返回操作。
 */
function PickerDialog(props: {
	title: string;
	hint?: string;
	onClose: () => void;
	className?: string;
	children: ReactNode;
}) {
	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent
				showCloseButton={false}
				className={cn(
					"flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(560px,calc(100vw-48px))]",
					props.className,
				)}
			>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<div className="grid gap-0.5">
						<DialogTitle>{props.title}</DialogTitle>
						{props.hint && (
							<small className="text-muted-foreground text-caption">{props.hint}</small>
						)}
					</div>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}><X size={18} strokeWidth={2.2} aria-hidden="true" /></Button>
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
	showGroupActions?: boolean;
	children: ReactNode;
}) {
	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent
				showCloseButton={false}
				className={cn(
					"flex max-h-[min(680px,calc(100vh-48px))] flex-col overflow-hidden p-0 sm:max-w-[min(560px,calc(100vw-48px))]",
					props.className,
				)}
			>
				<CommandPickerPanel
					title={props.title}
					hint={props.hint}
					searchPlaceholder={props.searchPlaceholder ?? t("app.commandPickerSearch")}
					emptyLabel={props.emptyLabel ?? t("app.commandPickerEmpty")}
					showGroupActions={props.showGroupActions}
					onClose={props.onClose}
				>
					{props.children}
				</CommandPickerPanel>
			</DialogContent>
		</Dialog>
	);
}

export function ModelPicker(props: {
	models: AvailableModel[];
	current?: { provider?: string; modelId?: string; modelName?: string };
	onClose: () => void;
	onPick: (model: AvailableModel) => void;
	/** 收藏的模型 ID 列表（格式：provider/modelId），收藏的模型独立置顶显示但仍保留在原供应商分组 */
	favoriteModels: string[];
	/** 切换收藏状态 */
	onToggleFavorite: (provider: string, modelId: string) => void;
}) {
	const currentModelKey = props.current?.provider && props.current?.modelId
		? `${props.current.provider}/${props.current.modelId}`
		: undefined;
	const favoritesSet = new Set(props.favoriteModels ?? []);

	// 收藏列表（从全部模型中提取，不移除原供应商分组下的显示）
	const favorites: AvailableModel[] = props.models.filter((model) =>
		favoritesSet.has(`${model.provider}/${model.id}`),
	);
	favorites.sort((a, b) => {
		const ap = a.provider ?? '';
		const bp = b.provider ?? '';
		if (ap !== bp) return ap.localeCompare(bp);
		return (a.name ?? a.id).localeCompare(b.name ?? b.id);
	});

	// 全量模型按供应商分组（收藏模型也保留在原分组）；
	// 搜索交给 cmdk（item 的 value/keywords 同时覆盖 name/id/provider）
	const groupedModels = groupModelsByProvider(props.models);
	const providerOrder = ['anthropic', 'openai', 'google', 'deepseek', 'other'];
	const sortedProviders = Object.keys(groupedModels).sort((a, b) => {
		const aIndex = providerOrder.indexOf(a);
		const bIndex = providerOrder.indexOf(b);
		if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
		if (aIndex !== -1) return -1;
		if (bIndex !== -1) return 1;
		return a.localeCompare(b);
	});

	const renderModelRow = (model: AvailableModel) => {
		const modelKey = `${model.provider}/${model.id}`;
		const selected = modelKey === currentModelKey;
		const favorited = favoritesSet.has(modelKey);
		return (
			<CommandItem
				key={modelKey}
				value={modelKey}
				data-picker-value={modelKey}
				keywords={[model.name ?? "", model.id, model.provider, modelKey]}
				onSelect={() => props.onPick(model)}
				className="picker-model-item"
			>
				{/* 收藏/取消收藏按钮：填充星为收藏，空心为未收藏 */}
				<span
					className={`model-favorite-star${favorited ? ' favorited' : ''}`}
					title={favorited ? t("app.modelUnfavorite") : t("app.modelFavorite")}
					onClick={(e) => {
						e.stopPropagation();
						props.onToggleFavorite(model.provider, model.id);
					}}
				>
					<Star size={14} strokeWidth={1.8} fill={favorited ? 'currentColor' : 'none'} />
				</span>
				<span
					className="min-w-0 flex-1 truncate font-mono text-control text-foreground"
					title={model.name ? `${model.name} · ${modelKey}` : modelKey}
				>
					{modelKey}
				</span>
				{selected && <Check size={14} className="ml-auto text-primary" aria-hidden="true" />}
			</CommandItem>
		);
	};

	return (
		<CommandPickerDialog
			title={t("app.modelPickerTitle")}
			onClose={props.onClose}
			className="model-picker"
			searchPlaceholder={t("app.modelPickerSearch")}
			emptyLabel={t("app.modelPickerEmpty")}
			showGroupActions
		>
			{favorites.length > 0 && (
				<CommandPickerGroup id="favorites" label={t("app.modelFavorites")} count={favorites.length}>
					{favorites.map(renderModelRow)}
				</CommandPickerGroup>
			)}
			{sortedProviders.map((provider) => (
				<CommandPickerGroup id={`provider:${provider}`} key={provider} label={provider} count={groupedModels[provider].length}>
					{groupedModels[provider].map(renderModelRow)}
				</CommandPickerGroup>
			))}
		</CommandPickerDialog>
	);
}

export function ComposerModePicker(props: {
	currentMode: ComposerAgentMode;
	onClose: () => void;
	onPick: (mode: ComposerAgentMode) => void;
}) {
	const items = [
		{
			value: "normal" as const,
			labelKey: "app.composerModeNormal" as const,
			descriptionKey: "app.composerModeNormalDesc" as const,
		},
		{
			value: "plan" as const,
			labelKey: "app.composerModePlan" as const,
			descriptionKey: "app.composerModePlanDesc" as const,
		},
	];

	return (
		<CommandPickerDialog
			title={t("app.composerModeTitle")}
			onClose={props.onClose}
			className="composer-mode-picker"
		>
			{items.map((item) => {
				const selected = item.value === props.currentMode;
				return (
					<CommandItem
						key={item.value}
						value={item.value}
						data-picker-value={item.value}
						onSelect={() => props.onPick(item.value)}
					>
						<span className="min-w-0 flex-1">
							<span className="block text-control font-medium">{t(item.labelKey)}</span>
							<span className="block text-caption text-muted-foreground">{t(item.descriptionKey)}</span>
						</span>
						{selected && <Check size={14} className="ml-auto text-primary" aria-hidden="true" />}
					</CommandItem>
				);
			})}
		</CommandPickerDialog>
	);
}

export function ThinkingPicker(props: {
	current?: string;
	onClose: () => void;
	onPick: (level: string) => void;
}) {
	return (
		<CommandPickerDialog
			title={t("app.thinkingPickerTitle")}
			hint={t("app.thinkingPickerHint")}
			onClose={props.onClose}
			className="thinking-picker"
		>
			{THINKING_LEVELS.map((level) => {
				const selected = level.value === props.current;
				return (
					<CommandItem
						key={level.value}
						value={level.value}
						data-picker-value={level.value}
						onSelect={() => props.onPick(level.value)}
					>
						<span className="min-w-0 flex-1">
							<span className="block text-control font-medium">{t(level.labelKey)}</span>
							<span className="block text-caption text-muted-foreground">{t(level.descriptionKey)}</span>
						</span>
						{selected && <Check size={14} className="ml-auto text-primary" aria-hidden="true" />}
					</CommandItem>
				);
			})}
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
	onPick: (template: {
		name: string;
		path: string;
		description: string;
		content: string;
		scope?: "global" | "project";
		argumentHint?: string;
	}) => void;
}) {
	type TemplateItem = typeof props.templates[number];
	const [previewTemplate, setPreviewTemplate] = useState<TemplateItem | null>(null);

	// 预览态：替换标题为返回按钮 + 模板名，正文为模板内容（沿用旧内联预览设计）
	if (previewTemplate) {
		return (
			<PickerDialog
				title={t("app.promptTemplatePreviewTitle", { name: "/" + previewTemplate.name })}
				onClose={props.onClose}
				className="prompt-template-picker"
			>
				<div className="picker-preview-inline">
					<Button
						type="button"
						className="picker-preview-back-btn h-auto gap-1 px-1 text-caption"
						onClick={() => setPreviewTemplate(null)}
						title={t("app.promptTemplateBackToPicker")}
					>
						<ChevronLeft size={16} strokeWidth={2.2} />
						{t("app.promptTemplateBackToPicker")}
					</Button>
					<pre className="picker-preview-content">{previewTemplate.content}</pre>
				</div>
			</PickerDialog>
		);
	}

	return (
		<PickerDialog title={t("app.promptTemplatePickerTitle")} onClose={props.onClose} className="prompt-template-picker">
			<Command>
				<CommandInput placeholder={t("app.promptTemplateSearchPlaceholder")} autoFocus />
				<CommandList>
					<CommandEmpty>{t("app.promptTemplateSearchEmpty")}</CommandEmpty>
					{props.templates.length === 0 && (
						<div className="py-6 text-center text-body text-muted-foreground">{t("app.promptTemplateEmpty")}</div>
					)}
					{props.templates.map((template) => (
						<CommandItem
							key={template.path}
							value={`/${template.name}`}
							keywords={[template.name, template.description]}
							onSelect={() => props.onPick(template)}
						>
							<FileText size={14} strokeWidth={1.8} aria-hidden="true" />
							<span className="picker-palette-label">/{template.name}</span>
							{template.argumentHint && (
								<code className="picker-palette-arg-hint">{template.argumentHint}</code>
							)}
							<span className="picker-palette-desc">{template.description}</span>
							<Button
								type="button"
								className="picker-palette-preview-btn"
								title={t("common.preview")}
								onClick={(e) => {
									e.stopPropagation();
									setPreviewTemplate(template);
								}}
							>
								<Eye size={14} strokeWidth={1.8} />
							</Button>
						</CommandItem>
					))}
				</CommandList>
			</Command>
		</PickerDialog>
	);
}
