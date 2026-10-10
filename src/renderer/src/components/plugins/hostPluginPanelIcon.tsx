import { Activity, BarChart3, Calendar, Clock, Database, FileText, GitBranch, Globe, Layers, MessageSquare, Puzzle, Table, Terminal, type LucideIcon } from "lucide-react";
import type { HostPluginPanelIconName } from "../../../../shared/hostPluginIcons";

/**
 * manifest 面板图标的渲染映射：键集与 `shared/hostPluginIcons.ts` 白名单一致，
 * 未声明 icon 的面板用 Puzzle 兜底。静态 Record 保证图标随 bundle 打包，
 * 不因插件内容引入动态 import。
 */
const PANEL_ICONS: Record<HostPluginPanelIconName, LucideIcon> = {
	"bar-chart": BarChart3,
	activity: Activity,
	database: Database,
	table: Table,
	calendar: Calendar,
	"file-text": FileText,
	terminal: Terminal,
	globe: Globe,
	"git-branch": GitBranch,
	message: MessageSquare,
	clock: Clock,
	layers: Layers,
};

export function hostPluginPanelIcon(name: string | undefined): LucideIcon {
	// 双保险：manifest 校验已拒绝白名单外的名字，这里再窄化一次防御历史数据。
	return (name && name in PANEL_ICONS ? PANEL_ICONS[name as HostPluginPanelIconName] : undefined) ?? Puzzle;
}
