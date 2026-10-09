import { useAtom, useAtomValue } from "jotai";
import type { LucideIcon } from "lucide-react";
import { hostPluginCatalogAtom, hostPluginPanelAtom } from "../../atoms/host-plugin-atoms";
import { hostPluginPanelIcon } from "./hostPluginPanelIcon";

/**
 * 侧栏顶部动作区的宿主插件入口（定时任务下方）：每个已启用面板一行。
 * 点击与设置页/命令面板共用 hostPluginPanelAtom，同一条打开路径；
 * 无已启用面板时整体不渲染，不给侧栏留空区块。
 */
export function HostPluginDockButtons() {
	const { catalog } = useAtomValue(hostPluginCatalogAtom);
	const [selected, openPanel] = useAtom(hostPluginPanelAtom);
	const rows: Array<{ key: string; pluginId: string; panelId: string; icon: LucideIcon; title: string; presentation?: string }> = [];
	for (const plugin of catalog?.plugins ?? []) {
		if (!plugin.enabled) continue;
		const panels = plugin.manifest.contributes.panels;
		for (const panel of panels) {
			// 同一插件贡献多个面板时带插件名前缀，单面板直接用面板标题（侧栏行窄，优先短）。
			rows.push({ key: `${plugin.manifest.id}:${panel.id}`, pluginId: plugin.manifest.id, panelId: panel.id, icon: hostPluginPanelIcon(panel.icon), title: panels.length > 1 ? `${plugin.manifest.name}: ${panel.title}` : panel.title, presentation: panel.presentation });
		}
	}
	if (rows.length === 0) return null;
	return (
		<>
			{rows.map((row) => (
				<button
					key={row.key}
					type="button"
					className="group flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-body text-foreground transition-colors hover:bg-muted/60"
					aria-label={row.title}
					title={row.title}
					onClick={() => (selected?.pluginId === row.pluginId && selected?.panelId === row.panelId && row.presentation === "page" ? openPanel(null) : openPanel({ pluginId: row.pluginId, panelId: row.panelId }))}
				>
					<row.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate font-medium">{row.title}</span>
				</button>
			))}
		</>
	);
}
