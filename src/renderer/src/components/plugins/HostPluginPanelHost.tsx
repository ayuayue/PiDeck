import { useAtom, useAtomValue } from "jotai";
import { hostPluginCatalogAtom, hostPluginPanelAtom } from "../../atoms/host-plugin-atoms";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { hostPluginPanelIcon } from "./hostPluginPanelIcon";
import { NativePluginSurface } from "./HostPluginSurface";

/** Modal 面板宿主（manifest presentation:"modal" 或缺省）；page 面板走 HostPluginPageOverlay。 */
export function HostPluginPanelHost({ projectId, sessionId }: { projectId?: string; sessionId?: string }) {
	const [selected, setSelected] = useAtom(hostPluginPanelAtom);
	const { catalog } = useAtomValue(hostPluginCatalogAtom);
	const plugin = catalog?.plugins.find((item) => item.enabled && item.manifest.id === selected?.pluginId);
	const panel = plugin?.manifest.contributes.panels.find((item) => item.id === selected?.panelId);
	// page 面板不进 Dialog：由工作区内联页呈现，这里直接不渲染。
	const open = Boolean(plugin && panel && panel.presentation !== "page");
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!value) setSelected(null);
			}}
		>
			{/* 与 AutomationModal 同一尺寸语系：近全屏大页面感，而不是小弹框（用户反馈的统计页面场景） */}
			<DialogContent size="xl" stagger showCloseButton={false} className="flex h-[min(760px,calc(100vh-64px))] max-w-[min(1100px,calc(100vw-48px))] flex-col gap-0 overflow-hidden bg-background p-0" aria-describedby={undefined} onOpenAutoFocus={(event) => event.preventDefault()}>
				<DialogHeader className="shrink-0 flex-row items-center justify-between border-b px-4 py-3">
					<DialogTitle className="flex items-center gap-2">
						{(() => {
							const Icon = hostPluginPanelIcon(panel?.icon);
							return <Icon className="size-4 text-muted-foreground" aria-hidden="true" />;
						})()}
						{plugin?.manifest.name}: {panel?.title}
					</DialogTitle>
					<Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
						{t("common.close")}
					</Button>
				</DialogHeader>
				{open && plugin && panel && <NativePluginSurface key={`${plugin.manifest.id}:${panel.id}:${plugin.fingerprint}`} pluginId={plugin.manifest.id} panelId={panel.id} projectId={projectId} sessionId={sessionId} />}
			</DialogContent>
		</Dialog>
	);
}
