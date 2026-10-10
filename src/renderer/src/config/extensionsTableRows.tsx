import { Button } from "../components/ui-shadcn/button";
import { Switch } from "../components/ui-shadcn/switch";
import { TableCell, TableRow } from "../components/ui-shadcn/table";
import { Copy, FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import type { PiExtensionSummary } from "../../../shared/types";
import { isActionableProjectPackageItem } from "./resourceScopeModel";
import { t, type TranslationKey } from "../i18n";

/**
 * 内置扩展 source → 简介 key（i18n 双语，见 rendererCopy 的 builtInExtDesc.*）。
 * 内置扩展集合是静态白名单（builtInExtensions.ts），在渲染层直接映射即可，
 * 无需为描述字段扩展 IPC/共享类型；映射缺失时不渲染描述行（未知内置扩展兜底）。
 */
const BUILT_IN_EXTENSION_DESC: Record<string, TranslationKey> = {
	"pi-deck-gui-bridge.ts": "config.builtInExtDesc.pi-deck-gui-bridge",
	"pi-deck-ext-points.ts": "config.builtInExtDesc.pi-deck-ext-points",
	"pi-deck-request-size-recovery.ts": "config.builtInExtDesc.pi-deck-request-size-recovery",
	"pi-deck-ask-question.ts": "config.builtInExtDesc.pi-deck-ask-question",
	"pi-deck-goal-mode.ts": "config.builtInExtDesc.pi-deck-goal-mode",
	"pi-deck-model-trace.ts": "config.builtInExtDesc.pi-deck-model-trace",
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
	/** 包版本（发现链路从包 package.json 带出）；settings-* 行缺省。 */
	version?: string;
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
						    版本查询/更新/卸载均用干净 source；此处仅展示标记。
						    停用行不显示：pi list 对「对象形态」一律标 filtered，而 PiDeck 整包停用写的
						    四类空数组也是对象——用户只是关了开关，不该被说成过滤式安装；
						    重新启用后条目已折回纯字符串（collapsePackageEntry），徽标自然不会回来。 */}
						{extension.filtered && effectiveEnabled && <span className="text-micro text-muted-foreground">{t("config.extensionFiltered")}</span>}
						{disabled && <span className="text-micro text-muted-foreground">{t("config.extensionDisabledBadge")}</span>}
					</div>
					<span className="truncate font-mono text-caption text-muted-foreground">{extension.source}</span>
					{/* 内置扩展简介：只有名称和路径时用户不知道扩展干什么（用户反馈）。
					    限 2 行 + title 兜底：完整文案悬停可见，同时不让长简介把列撑宽。 */}
					{extension.builtIn && BUILT_IN_EXTENSION_DESC[extension.source] && (
						<span className="line-clamp-2 text-caption leading-4 text-muted-foreground" title={t(BUILT_IN_EXTENSION_DESC[extension.source])}>
							{t(BUILT_IN_EXTENSION_DESC[extension.source])}
						</span>
					)}
				</div>
			</TableCell>
			<TableCell className="whitespace-nowrap text-caption text-muted-foreground">
				{extension.builtIn
					? // 内置扩展是**包级**版本号（extensions-manifest.json，不跟 PiDeck 应用版本走）：
						// 只显示当前生效版本（覆盖层优先），「最新」与更新入口由上方内置扩展面板统一负责。
						t("config.builtInExt.rowVersion", { version: extension.currentVersion ?? "-" })
					: t("config.extensionVersions", {
							current: extension.currentVersion ?? "-",
							latest: extension.latestVersion ?? "-",
						})}
				{extension.hasUpdate && <span className="ml-1 text-text-primary">{t("config.extensionUpdateAvailable")}</span>}
				{/* 有更新时提供单扩展更新与复制更新指令（npm 包专属；内置扩展走包级热更新面板） */}
				{extension.hasUpdate && !extension.builtIn && (
					<div className="mt-1.5 flex items-center gap-1.5">
						<Button size="xs" variant="outline" onClick={() => props.onUpdateOne(extension)} disabled={props.updatingOne} aria-busy={props.updatingOne}>
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
					<Button variant="ghost" size="icon-sm" className="size-7" disabled={!extension.path} onClick={() => props.onShowInFolder(extension)} title={t("config.openExtensionLocation")}>
						<FolderOpen size={14} strokeWidth={1.8} />
					</Button>
					{/* 启停开关：Switch 轨道着色（启用 = 主题色填充），避免 Toggle 图标几乎无视觉差;
					    内置扩展也复用 extensions:toggle；项目作用域下继承的全局行只写项目覆盖，
					    全局已禁用的项不可在项目视图重新启用 */}
					<Switch
						checked={effectiveEnabled}
						onCheckedChange={(checked) => props.onToggle(extension, checked)}
						disabled={props.toggling || props.uninstalling || (inherited && extension.enabled === false)}
						title={props.toggling ? t("config.extensionToggling") : effectiveEnabled ? t("config.extensionDisable") : t("config.extensionEnable")}
						aria-busy={props.toggling}
					/>
					{/* 内置行卸载（removeBuiltIn）：不限于启用态——已禁用的内置扩展同样可移除，避免「先禁用就再也即不掉」 */}
					{extension.builtIn && !inherited && (
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

/**
 * 运行时发现（package/settings 声明的扩展）发现行。
 * 例外：package-project 行（项目层安装的包，source 即 `npm:<name>` 包源）接整包开关与卸载，
 * 后端与全局行同一回路（项目层 packages delta / `pi remove -l`），见 isActionableProjectPackageItem。
 * 其余发现行（settings-*、package-user）由设置或全局层管理，在此只读。
 */
export function DiscoveredExtensionRow(props: {
	item: DiscoveredExtensionItem;
	/** 乐观覆盖后的显示态（仅可操作行使用；只读行忽略，始终 item.enabled）。 */
	effectiveEnabled: boolean;
	toggling?: boolean;
	onToggle?: (item: DiscoveredExtensionItem, enabled: boolean) => void;
	uninstalling?: boolean;
	onUninstall?: (item: DiscoveredExtensionItem) => void;
	/** 更新进行态（与已装行共用 updatingOne，按 source 匹配）。 */
	updating?: boolean;
	/** 整包更新（`pi upgrade <source>`）；仅可操作的项目包行提供。 */
	onUpdate?: (item: DiscoveredExtensionItem) => void;
	/** 打开安装位置（settings-* 行也有 path，同样提供；授权由 ConfigModal 按 physicalScope 决定项目边界）。 */
	onShowInFolder?: (item: DiscoveredExtensionItem) => void;
}) {
	const { item } = props;
	const actionable = isActionableProjectPackageItem(item) && Boolean(props.onToggle && props.onUninstall);
	const name = item.source.replace(/^(?:npm|file|github|git):/i, "").replace(/\.ts$/i, "");
	return (
		<TableRow>
			{/* 同 ExtensionTableRow：基类 nowrap 会把这一列顶宽，需显式恢复换行 */}
			<TableCell className="min-w-0 whitespace-normal">
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-2">
						<strong className="truncate text-control font-medium text-foreground">{name}</strong>
						<span className="text-micro" title={t("config.resourceManagedHint")}>
							{/* 徽标按条目物理层归属标注：项目层装的包不再误标「全局」（此前所有发现行一律标全局） */}
							{item.physicalScope === "project" ? t("config.source.project") : t("config.source.global")}
						</span>
					</div>
					<span className="truncate font-mono text-caption text-muted-foreground">{item.sourceLabel}</span>
				</div>
			</TableCell>
			{/* 版本：发现链路从包 package.json 带出；settings-* 行与无清单包显示 - */}
			<TableCell className="whitespace-nowrap text-caption text-muted-foreground">{item.version ?? "-"}</TableCell>
			<TableCell className="text-right">
				{(actionable || props.onShowInFolder) && (
					<div className="flex items-center justify-end gap-1">
						{/* 打开安装位置：对齐已装行的文件夹按钮（disabled={!item.path}）。 */}
						{props.onShowInFolder && (
							<Button variant="ghost" size="icon-sm" className="size-7" disabled={!item.path} onClick={() => props.onShowInFolder?.(item)} title={t("config.openExtensionLocation")}>
								<FolderOpen size={14} strokeWidth={1.8} />
							</Button>
						)}
						{/* 整包更新 = `pi upgrade <source>`：与已装行同一回路（updateOne），仅项目包行提供。 */}
						{actionable && props.onUpdate && (
							<Button variant="ghost" size="icon-sm" className="size-7" disabled={props.updating || props.uninstalling} onClick={() => props.onUpdate?.(item)} title={props.updating ? t("config.extensionUpdatingOne") : t("config.extensionUpdateOne")}>
								<RefreshCw size={14} strokeWidth={1.8} className={props.updating ? "animate-spin" : undefined} />
							</Button>
						)}
						{actionable && (
							<>
								{/* 整包开关：停用写项目层四类 `!` 排除 delta、启用折回纯字符串（与全局行同构）；
							    显示态用调用方传入的乐观值，写盘+刷新落地后才回落真值。 */}
								<Switch
									checked={props.effectiveEnabled}
									onCheckedChange={(checked) => props.onToggle?.(item, checked)}
									disabled={props.toggling || props.uninstalling}
									title={props.toggling ? t("config.extensionToggling") : props.effectiveEnabled ? t("config.extensionDisable") : t("config.extensionEnable")}
									aria-busy={props.toggling}
								/>
								{/* 卸载 = `pi remove <source> -l`：只删项目层记账、不动全局缓存；确认弹窗在 ConfigModal。 */}
								<Button variant="ghost" size="icon-sm" className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={props.uninstalling} onClick={() => props.onUninstall?.(item)} title={props.uninstalling ? t("config.uninstalling") : t("config.uninstall")}>
									<Trash2 size={14} strokeWidth={1.8} />
								</Button>
							</>
						)}
					</div>
				)}
			</TableCell>
		</TableRow>
	);
}
