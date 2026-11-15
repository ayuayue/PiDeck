import { FileText, PlugZap, Puzzle, Shield, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "../../i18n";
import { TabsList, TabsTrigger } from "../../components/ui-shadcn/tabs";
import type { ConfigTab } from "../configTypes";

/** 导航项：id 决定 Tabs value（`config:<id>`）与未保存黄点 key。 */
export type ConfigNavItem = { id: ConfigTab; label: string; icon: ReactNode };

export type ConfigNavSidebarProps = {
	/** 资源管理器模式：只显示资源页 + 项目作用域 MCP 入口。 */
	resourceOnly: boolean;
	/** 当前环境支持的配置页（能力表过滤后的结果）。 */
	items: readonly ConfigNavItem[];
	dirtyTabs: ReadonlySet<string>;
	showSecurityPage: boolean;
	showResourcePages: boolean;
};

/**
 * 配置弹窗左侧导航（shadcn Vertical Tabs 的 TabsList）：按环境能力表渲染分组，
 * 未保存的黄点与 DSH 导航同款。只读 props，不持有状态。
 */
export function ConfigNavSidebar({ resourceOnly, items, dirtyTabs, showSecurityPage, showResourcePages }: ConfigNavSidebarProps) {
	return (
		// scroll-ok: transient —— 一次性弹窗 / 设置面板：内容随交互生命周期结束，不是随数据增长的列表。
		<TabsList
			className="config-sidebar flex min-h-0 shrink-0 flex-col items-stretch gap-2.5 overflow-auto border-0 border-r border-border rounded-none bg-transparent p-2.5 data-[orientation=vertical]:w-[160px] max-[820px]:flex-row max-[820px]:gap-3 max-[820px]:overflow-x-auto max-[820px]:overflow-y-hidden max-[820px]:border-r-0 max-[820px]:border-b"
			aria-label={t("config.title")}
		>
			{!resourceOnly && (
				<div className="config-sidebar-group grid gap-0.5">
					<span className="px-2 pb-1 text-micro font-semibold text-muted-foreground">{t("config.group.config")}</span>
					{items.map((item) => (
						<TabsTrigger key={item.id} value={`config:${item.id}`} className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
							<span className="config-nav-icon">{item.icon}</span>
							{item.label}
							{/* 未保存黄点：与 DSH 导航同款 */}
							{dirtyTabs.has(`config:${item.id}`) || dirtyTabs.has(item.id) ? <span className="ml-auto size-1.5 rounded-full bg-warning" aria-hidden="true" /> : null}
						</TabsTrigger>
					))}
				</div>
			)}
			{/* ssh 环境没有任何「Agent 能力」页（资源未路由、安全策略只在本机）：整组连标题一起不渲染 */}
			{showSecurityPage || showResourcePages ? (
				<div className="config-sidebar-group grid gap-0.5">
					<span className="px-2 pb-1 text-micro font-semibold text-muted-foreground">{t("config.group.agent")}</span>
					{!resourceOnly && showSecurityPage && (
						<TabsTrigger value="security" className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
							<span className="config-nav-icon">
								<Shield size={14} aria-hidden="true" />
							</span>
							{t("config.nav.security")}
						</TabsTrigger>
					)}
					{showResourcePages && (
						<TabsTrigger value="extensions" className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
							<span className="config-nav-icon">
								<Puzzle size={14} aria-hidden="true" />
							</span>
							{t("config.nav.extensions")}
						</TabsTrigger>
					)}
					{/* MCP 在配置管理弹窗里由「配置文件」组的 config:mcp 承担（全局作用域 + 导入扫描源）；
					    这里只在项目资源管理器（resourceOnly）提供项目作用域入口，避免同名双入口用户无法选择。 */}
					{resourceOnly && (
						<TabsTrigger value="mcp" className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
							<span className="config-nav-icon">
								<PlugZap size={14} aria-hidden="true" />
							</span>
							{t("config.nav.mcp")}
						</TabsTrigger>
					)}
					{showResourcePages && (
						<>
							<TabsTrigger value="skills" className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
								<span className="config-nav-icon">
									<Sparkles size={14} aria-hidden="true" />
								</span>
								{t("config.nav.skills")}
							</TabsTrigger>
							<TabsTrigger value="prompts" className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
								<span className="config-nav-icon">
									<FileText size={14} aria-hidden="true" />
								</span>
								{t("config.nav.prompts")}
							</TabsTrigger>
						</>
					)}
				</div>
			) : null}
		</TabsList>
	);
}
