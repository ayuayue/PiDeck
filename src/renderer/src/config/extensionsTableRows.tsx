import { Button } from "../components/ui-shadcn/button";
import { TableCell, TableRow } from "../components/ui-shadcn/table";
import { Copy, FolderOpen, ToggleLeft, ToggleRight, Trash2 } from "lucide-react";
import type { PiExtensionSummary } from "../../../shared/types";
import { t, type TranslationKey } from "../i18n";

/**
 * 内置扩展 source → 简介 key（i18n 双语，见 rendererCopy 的 builtInExtDesc.*）。
 * 内置扩展集合是静态白名单（builtInExtensions.ts），在渲染层直接映射即可，
 * 无需为描述字段扩展 IPC/共享类型；映射缺失时不渲染描述行（未知内置扩展兜底）。
 */
const BUILT_IN_EXTENSION_DESC: Record<string, TranslationKey> = {
	"pi-deck-request-size-recovery.ts": "config.builtInExtDesc.pi-deck-request-size-recovery",
	"pi-deck-ask-question.ts": "config.builtInExtDesc.pi-deck-ask-question",
	"pi-deck-goal-mode.ts": "config.builtInExtDesc.pi-deck-goal-mode",
	"pi-deck-nul-redirect-fix.ts": "config.builtInExtDesc.pi-deck-nul-redirect-fix",
	"pi-deck-plan-mode.ts": "config.builtInExtDesc.pi-deck-plan-mode",
	"pi-deck-retry-no-body.ts": "config.builtInExtDesc.pi-deck-retry-no-body",
	"pi-deck-security-gate.ts": "config.builtInExtDesc.pi-deck-security-gate",
	"pi-deck-session-title.ts": "config.builtInExtDesc.pi-deck-session-title",
	"pi-deck-subagents.ts": "config.builtInExtDesc.pi-deck-subagents",
	"pi-deck-todo.ts": "config.builtInExtDesc.pi-deck-todo",
	"pi-deck-trash-guard.ts": "config.builtInExtDesc.pi-deck-trash-guard",
	"pi-deck-vision.ts": "config.builtInExtDesc.pi-deck-vision",
};

/** 运行时发现（package/settings）扩展条目的只读描述。 */
export type DiscoveredExtensionItem = {
	source: string;
	path: string;
	sourceId: string;
	sourceLabel: string;
	physicalScope: "user" | "project";
	enabled: boolean;
	managed: boolean;
};

/**
 * 已安装扩展表格行：所有扩展共用启停开关；内置扩展另保留移除入口，普通扩展提供卸载；
 * 项目作用域下继承的全局行只读（无卸载/移除，开关只写项目覆盖）。
 */
export function ExtensionTableRow(props: {
	extension: PiExtensionSummary;
	effectiveEnabled: boolean;
	inherited: boolean;
	uninstalling: boolean;
	onUninstall: (extension: PiExtensionSummary) => void;
	onRemoveBuiltIn: (extension: PiExtensionSummary) => void;
	removingBuiltIn?: boolean;
	toggling?: boolean;
	onToggle: (extension: PiExtensionSummary, enabled: boolean) => void | Promise<void>;
	updatingOne: boolean;
	onUpdateOne: (extension: PiExtensionSummary) => void;
	onCopyUpdateCommand: (extension: PiExtensionSummary) => void;
	onShowInFolder: (extension: PiExtensionSummary) => void;
}) {
	const { extension, effectiveEnabled, inherited } = props;
	const name = extension.source.replace(/^(?:npm|file|github|git):/i, "");
	const disabled = extension.enabled === false;
	return (
		<TableRow aria-busy={props.uninstalling}>
			{/* whitespace-normal 必须显式加回来：TableCell 基类默认 nowrap，而这里会渲染
			    最长 90 字的中文简介，nowrap 会让本列的 min-content = 整行文字宽度（≈1000px），
			    表格宽度被顶穿 → 版本列截断、操作列整个被挤出可视区（用户反馈的显示错乱）。
			    允许换行后本列 min-content 由 truncate/line-clamp 收敛到接近 0，表格才能缩进容器。 */}
			<TableCell className="min-w-0 whitespace-normal">
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-2">
						{/* 禁用态弱化名称，避免与启用扩展抢视觉层级 */}
						<strong className={`truncate text-control font-medium text-foreground${disabled ? " opacity-50" : ""}`}>{name}</strong>
						{extension.builtIn && <span className="text-micro text-muted-foreground">{t("common.builtIn")}</span>}
						{/* 过滤式安装徽标：source 已在主进程剥离 "(filtered)" 后缀，
						    版本查询/更新/卸载均用干净 source；此处仅展示标记 */}
						{extension.filtered && <span className="text-micro text-muted-foreground">{t("config.extensionFiltered")}</span>}
						{disabled && (
							<span className="text-micro text-muted-foreground">{t("config.extensionDisabledBadge")}</span>
						)}
					</div>
					<span className="truncate font-mono text-caption text-muted-foreground">{extension.source}</span>
					{/* 内置扩展简介：只有名称和路径时用户不知道扩展干什么（用户反馈）。
					    限 2 行 + title 兜底：完整文案悬停可见，同时不让长简介把列撑宽。 */}
					{extension.builtIn && BUILT_IN_EXTENSION_DESC[extension.source] && (
						<span
							className="line-clamp-2 text-caption leading-4 text-muted-foreground"
							title={t(BUILT_IN_EXTENSION_DESC[extension.source])}
						>
							{t(BUILT_IN_EXTENSION_DESC[extension.source])}
						</span>
					)}
				</div>
			</TableCell>
			<TableCell className="whitespace-nowrap text-caption text-muted-foreground">
				{extension.builtIn
					// 内置扩展是**包级**版本号（extensions-manifest.json，不跟 PiDeck 应用版本走）：
					// 只显示当前生效版本（覆盖层优先），「最新」与更新入口由上方内置扩展面板统一负责。
					? t("config.builtInExt.rowVersion", { version: extension.currentVersion ?? "-" })
					: t("config.extensionVersions", {
						current: extension.currentVersion ?? "-",
						latest: extension.latestVersion ?? "-",
					})}
				{extension.hasUpdate && <span className="ml-1 text-text-primary">{t("config.extensionUpdateAvailable")}</span>}
				{/* 有更新时提供单扩展更新与复制更新指令（npm 包专属；内置扩展走包级热更新面板） */}
				{extension.hasUpdate && !extension.builtIn && (
					<div className="mt-1.5 flex items-center gap-1.5">
						<Button
							size="xs"
							variant="outline"
							onClick={() => props.onUpdateOne(extension)}
							disabled={props.updatingOne}
							aria-busy={props.updatingOne}
						>
							{props.updatingOne ? t("config.extensionUpdatingOne") : t("config.extensionUpdateOne")}
						</Button>
						<Button size="xs" variant="ghost" onClick={() => props.onCopyUpdateCommand(extension)}>
							<Copy size={13} strokeWidth={1.8} className="mr-1" aria-hidden="true" />
							{t("config.extensionCopyUpdateCommand")}
						</Button>
					</div>
				)}
				{extension.updateError && <div className="text-destructive">{extension.updateError}</div>}
			</TableCell>
			<TableCell className="text-right">
				<div className="flex justify-end gap-1">
					{/* 文件位置：真实安装路径（主进程按项目边界授权打开） */}
					<Button
						variant="ghost"
						size="icon-sm"
						className="size-7"
						disabled={!extension.path}
						onClick={() => props.onShowInFolder(extension)}
						title={t("config.openExtensionLocation")}
					>
						<FolderOpen size={14} strokeWidth={1.8} />
					</Button>
					{/* 启停开关：内置扩展也复用 extensions:toggle；项目作用域下继承的全局行只写项目覆盖，
					    全局已禁用的项不可在项目视图重新启用 */}
					<Button
						variant="ghost"
						size="icon-sm"
						className={`size-7${effectiveEnabled ? " text-primary" : ""}`}
						disabled={props.toggling || props.uninstalling || (inherited && extension.enabled === false)}
						onClick={() => props.onToggle(extension, !effectiveEnabled)}
						title={
							props.toggling
								? t("config.extensionToggling")
								: effectiveEnabled
									? t("config.extensionDisable")
									: t("config.extensionEnable")
						}
						aria-busy={props.toggling}
					>
						{effectiveEnabled
							? <ToggleRight size={18} strokeWidth={1.8} />
							: <ToggleLeft size={18} strokeWidth={1.8} />}
					</Button>
					{extension.builtIn && extension.enabled !== false && !inherited && (
						<Button variant="ghost" size="icon-sm" className="size-7" disabled={props.removingBuiltIn} onClick={() => props.onRemoveBuiltIn(extension)} title={props.removingBuiltIn ? t("config.uninstalling") : t("config.uninstall")}>
							<Trash2 size={14} strokeWidth={1.8} />
						</Button>
					)}
					{!extension.builtIn && !inherited && (
						<Button variant="ghost" size="icon-sm" className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={props.uninstalling} onClick={() => props.onUninstall(extension)} title={props.uninstalling ? t("config.uninstalling") : t("config.uninstall")}>
							<Trash2 size={14} strokeWidth={1.8} />
						</Button>
					)}
				</div>
			</TableCell>
		</TableRow>
	);
}

/** 运行时发现（package/settings 声明的扩展）只读行：由包/设置管理，不提供行内操作。 */
export function DiscoveredExtensionRow(props: { item: DiscoveredExtensionItem }) {
	const { item } = props;
	const name = item.source
		.replace(/^(?:npm|file|github|git):/i, "")
		.replace(/\.ts$/i, "");
	return (
		<TableRow>
			{/* 同 ExtensionTableRow：基类 nowrap 会把这一列顶宽，需显式恢复换行 */}
			<TableCell className="min-w-0 whitespace-normal">
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-2">
						<strong className="truncate text-control font-medium text-foreground">{name}</strong>
						<span className="text-micro" title={t("config.resourceManagedHint")}>
							{t("config.source.global")}
						</span>
					</div>
					<span className="truncate font-mono text-caption text-muted-foreground">{item.sourceLabel}</span>
				</div>
			</TableCell>
			<TableCell className="whitespace-nowrap text-caption text-muted-foreground">-</TableCell>
			<TableCell className="text-right" />
		</TableRow>
	);
}
