import { Fragment } from "react";
import { useAtom, useAtomValue } from "jotai";
import type { LucideIcon } from "lucide-react";
import type { HostPluginPanelPresentation } from "../../../../shared/types/hostPlugin";
import { hostPluginCatalogAtom, hostPluginPanelAtom } from "../../atoms/host-plugin-atoms";
import { Popover, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";
import { HostPluginSurface } from "./HostPluginSurface";
import { hostPluginPanelIcon } from "./hostPluginPanelIcon";

/**
 * 侧栏顶部动作区的宿主插件入口（定时任务下方）：每个已启用面板一行。
 *
 * 打开方式由 manifest 的 presentation 决定，两种入口共用同一份面板代码：
 * - popover：面板就在这一行旁边展开（状态行 + 几个按钮这种紧凑面板，点开即用，不必占满屏幕）；
 * - modal / page：写 hostPluginPanelAtom，与设置页、命令面板共用同一条打开路径。
 *
 * 无已启用面板时整体不渲染，不给侧栏留空区块。
 */
export function HostPluginDockButtons({ projectId, sessionId }: { projectId?: string; sessionId?: string }) {
	const { catalog } = useAtomValue(hostPluginCatalogAtom);
	const [selected, openPanel] = useAtom(hostPluginPanelAtom);
	const rows: Array<{ key: string; pluginId: string; panelId: string; icon: LucideIcon; title: string; presentation: HostPluginPanelPresentation }> = [];
	for (const plugin of catalog?.plugins ?? []) {
		if (!plugin.enabled) continue;
		const panels = plugin.manifest.contributes.panels;
		for (const panel of panels) {
			// 同一插件贡献多个面板时带插件名前缀，单面板直接用面板标题（侧栏行窄，优先短）。
			rows.push({ key: `${plugin.manifest.id}:${panel.id}`, pluginId: plugin.manifest.id, panelId: panel.id, icon: hostPluginPanelIcon(panel.icon), title: panels.length > 1 ? `${plugin.manifest.name}: ${panel.title}` : panel.title, presentation: panel.presentation ?? "modal" });
		}
	}
	if (rows.length === 0) return null;
	return (
		<>
			{rows.map((row) => {
				const selectedRow = selected?.pluginId === row.pluginId && selected?.panelId === row.panelId;
				const trigger = (
					<button
						type="button"
						className="group flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-body text-foreground transition-colors hover:bg-muted/60"
						aria-label={row.title}
						title={row.title}
						// popover 面板由 PopoverTrigger 接管点击（asChild 会合并 onClick），这里不再自己开面板。
						onClick={row.presentation === "popover" ? undefined : () => (selectedRow && row.presentation === "page" ? openPanel(null) : openPanel({ pluginId: row.pluginId, panelId: row.panelId }))}
					>
						<row.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<span className="min-w-0 flex-1 truncate font-medium">{row.title}</span>
					</button>
				);
				if (row.presentation !== "popover") return <Fragment key={row.key}>{trigger}</Fragment>;
				return (
					<Popover key={row.key}>
						<PopoverTrigger asChild>{trigger}</PopoverTrigger>
						<PopoverContent align="start" side="right" sideOffset={6} className="w-80 gap-0 p-0">
							<div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
								<row.icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
								<span className="min-w-0 flex-1 truncate">{row.title}</span>
							</div>
							{/* 定高 flex 列：HostPluginSurface 内部是 flex-1 容器，非 flex 父级下高度会塌成 0，webview 跟着不可见。 */}
							<div className="flex h-[280px] flex-col">
								<HostPluginSurface pluginId={row.pluginId} panelId={row.panelId} projectId={projectId} sessionId={sessionId} />
							</div>
						</PopoverContent>
					</Popover>
				);
			})}
		</>
	);
}
