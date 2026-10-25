import { useAtom, useAtomValue } from "jotai";
import { hostPluginCatalogAtom, hostPluginPanelAtom } from "../../atoms/host-plugin-atoms";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { hostPluginPanelIcon } from "./hostPluginPanelIcon";
import { HostPluginSurface } from "./HostPluginSurface";

/**
 * 面板宿主（由 hostPluginPanelAtom 驱动）：modal 走近全屏对话框，popover 面板走小对话框，page 面板走 HostPluginPageOverlay。
 * 侧栏那一行旁边的浮层不走这里，见 HostPluginDockButtons。
 */
export function HostPluginPanelHost({ projectId, sessionId }: { projectId?: string; sessionId?: string }) {
	const [selected, setSelected] = useAtom(hostPluginPanelAtom);
	const { catalog } = useAtomValue(hostPluginCatalogAtom);
	const plugin = catalog?.plugins.find((item) => item.enabled && item.manifest.id === selected?.pluginId);
	const panel = plugin?.manifest.contributes.panels.find((item) => item.id === selected?.panelId);
	// page 面板不进 Dialog：由工作区内联页呈现，这里直接不渲染。
	// popover 面板的主入口是侧栏那一行旁边的浮层（HostPluginDockButtons）；
	// 从设置页/命令面板这类深入口进来时没有锚点，退化成小对话框，而不是近全屏大页面。
	const presentation = panel?.presentation ?? "modal";
	const compact = presentation === "popover";
	const open = Boolean(plugin && panel && presentation !== "page");
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!value) setSelected(null);
			}}
		>
			<DialogContent
				size={compact ? "default" : "xl"}
				stagger
				showCloseButton={false}
				className={
					compact
						? "flex h-[min(340px,calc(100vh-64px))] w-[min(380px,calc(100vw-48px))] flex-col gap-0 overflow-hidden bg-background p-0"
						: // 与定时任务页面同一尺寸语系：近全屏大页面感，而不是小弹框（用户反馈的统计页面场景）
							"flex h-[min(760px,calc(100vh-64px))] max-w-[min(1100px,calc(100vw-48px))] flex-col gap-0 overflow-hidden bg-background p-0"
				}
				aria-describedby={undefined}
				onOpenAutoFocus={(event) => event.preventDefault()}
			>
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
				{open && plugin && panel && <HostPluginSurface key={`${plugin.manifest.id}:${panel.id}:${plugin.fingerprint}`} pluginId={plugin.manifest.id} panelId={panel.id} projectId={projectId} sessionId={sessionId} />}
			</DialogContent>
		</Dialog>
	);
}
