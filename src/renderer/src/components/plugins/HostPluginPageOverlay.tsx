import { useEffect, useRef } from "react";
import { useAtom, useAtomValue } from "jotai";
import { hostPluginCatalogAtom, hostPluginPanelAtom } from "../../atoms/host-plugin-atoms";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { hostPluginPanelIcon } from "./hostPluginPanelIcon";
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
	const Icon = hostPluginPanelIcon(panel.icon);
	return (
		// inset-0 只覆盖工作区会话列：侧栏、右侧抽屉、底部停靠栏保持可交互（非模态）
		<div className="absolute inset-0 z-30 flex flex-col bg-background" role="region" aria-label={`${plugin.manifest.name}: ${panel.title}`}>
			<div className="shrink-0 flex-row flex items-center justify-between border-b bg-background/95 px-4 py-2">
				<div className="flex items-center gap-2 text-body font-medium text-foreground">
					<Icon className="size-4 text-muted-foreground" aria-hidden="true" />
					{plugin.manifest.contributes.panels.length > 1 ? `${plugin.manifest.name}: ${panel.title}` : panel.title}
				</div>
				<Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
					{t("common.close")}
				</Button>
			</div>
			<HostPluginSurface key={`${plugin.manifest.id}:${panel.id}:${plugin.fingerprint}`} pluginId={plugin.manifest.id} panelId={panel.id} projectId={projectId} sessionId={sessionId} />
		</div>
	);
}
