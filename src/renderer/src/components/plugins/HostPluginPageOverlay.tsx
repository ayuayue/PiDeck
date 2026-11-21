import { useEffect, useRef } from "react";
import { useAtom, useAtomValue } from "jotai";
import { hostPluginCatalogAtom, hostPluginPanelAtom } from "../../atoms/host-plugin-atoms";
import { HostPluginSurface } from "./HostPluginSurface";

/**
 * 页面式插件面板（manifest presentation:"page"）：非模态覆盖工作区会话区，
 * 关闭即还原会话视图（会话树不卸载，滚动/草稿等内存态保留）。
 * modal 面板走 HostPluginPanelHost，两者共用 hostPluginPanelAtom 同一入口。
 * 切换会话/项目时自动收起：用户点侧栏另一个会话的意图是看那个会话，覆盖层不能反着盖住新会话。
 */
export function HostPluginPageOverlay({ projectId, sessionId }: { projectId?: string; sessionId?: string }) {
	const [selected, setSelected] = useAtom(hostPluginPanelAtom);
	const { catalog } = useAtomValue(hostPluginCatalogAtom);
	const lastScope = useRef<string | undefined>(undefined);
	useEffect(() => {
		const scope = `${projectId ?? ""}|${sessionId ?? ""}`;
		if (lastScope.current === undefined) {
			lastScope.current = scope;
			return;
		}
		if (scope !== lastScope.current) {
			lastScope.current = scope;
			// 会话/项目身份变化：收起页面式覆盖层，露出用户刚选的会话
			if (selected) setSelected(null);
		}
	}, [projectId, sessionId, selected, setSelected]);
	const plugin = catalog?.plugins.find((item) => item.enabled && item.manifest.id === selected?.pluginId);
	const panel = plugin?.manifest.contributes.panels.find((item) => item.id === selected?.panelId);
	if (!plugin || !panel || panel.presentation !== "page") return null;
	return (
		// inset-0 只覆盖工作区会话列：侧栏、右侧抽屉、底部停靠栏保持可交互（非模态）。
		// 不渲染页头：面板名已在会话 Tab 栏的伪 Tab 上，插件页自己也有范围/操作行，
		// 再叠一条「标题 + 关闭」既重复又占高度；关闭走伪 Tab 的 ×（simple 模式用侧栏入口切换）。
		<div data-close-scope="plugin" className="absolute inset-0 z-30 flex flex-col bg-background" role="region" aria-label={`${plugin.manifest.name}: ${panel.title}`}>
			<HostPluginSurface key={`${plugin.manifest.id}:${panel.id}:${plugin.fingerprint}`} pluginId={plugin.manifest.id} panelId={panel.id} projectId={projectId} sessionId={sessionId} />
		</div>
	);
}
