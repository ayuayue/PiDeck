import { useAtom, useAtomValue } from "jotai";
import { hostPluginCatalogAtom, hostPluginPanelAtom } from "../atoms/host-plugin-atoms";
import { hostPluginPanelIcon } from "../components/plugins/hostPluginPanelIcon";

/**
 * 页面式插件面板的伪 Tab 装配信息：panelAtom 选中且目标面板是 presentation:"page" 时，
 * 返回 { title, icon, onClose }（供 SessionTabsBar 渲染伪 Tab）；否则 null。
 * 查找逻辑与 HostPluginPageOverlay 同源：enabled 插件 + panels 里 id 匹配。
 */
export function useHostPluginPageTab(): { title: string; icon?: React.ComponentType<{ className?: string }>; onClose: () => void } | null {
	const [selected, setSelected] = useAtom(hostPluginPanelAtom);
	const { catalog } = useAtomValue(hostPluginCatalogAtom);
	const plugin = catalog?.plugins.find((item) => item.enabled && item.manifest.id === selected?.pluginId);
	const panel = plugin?.manifest.contributes.panels.find((item) => item.id === selected?.panelId);
	if (!plugin || !panel || panel.presentation !== "page") return null;
	return {
		title: plugin.manifest.contributes.panels.length > 1 ? `${plugin.manifest.name}: ${panel.title}` : panel.title,
		icon: hostPluginPanelIcon(panel.icon),
		onClose: () => setSelected(null),
	};
}
