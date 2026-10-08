import { useRef } from "react";
import { useAtom, useAtomValue } from "jotai";
import { hostPluginCatalogAtom, hostPluginPanelAtom } from "../../atoms/host-plugin-atoms";
import { useHostPluginView } from "../../hooks/plugins/useHostPluginView";
import { t } from "../../i18n";
import { Alert, AlertDescription } from "../ui-shadcn/alert";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { LoaderCircle } from "lucide-react";

/** One workbench mount, scoped to the focused session rather than a pi agent identity. */
export function HostPluginPanelHost({ projectId, sessionId }: { projectId?: string; sessionId?: string }) {
	const [selected, setSelected] = useAtom(hostPluginPanelAtom);
	const { catalog } = useAtomValue(hostPluginCatalogAtom);
	const plugin = catalog?.plugins.find((item) => item.enabled && item.manifest.id === selected?.pluginId);
	const panel = plugin?.manifest.contributes.panels.find((item) => item.id === selected?.panelId);
	const open = Boolean(plugin && panel);
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!value) setSelected(null);
			}}
		>
			<DialogContent size="xl" showCloseButton={false} className="flex flex-col gap-0 overflow-hidden p-0" aria-describedby={undefined} onOpenAutoFocus={(event) => event.preventDefault()}>
				<DialogHeader className="shrink-0 flex-row items-center justify-between border-b px-4 py-3">
					<DialogTitle>
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

/** Keep host loading/errors outside the native page; a plugin crash does not replace the workbench. */
function NativePluginSurface({ pluginId, panelId, projectId, sessionId }: { pluginId: string; panelId: string; projectId?: string; sessionId?: string }) {
	const element = useRef<HTMLDivElement>(null);
	const { error, loading } = useHostPluginView(element, pluginId, panelId, projectId, sessionId);
	return (
		<div ref={element} className="min-h-0 flex-1 overflow-hidden">
			{error ? (
				<Alert variant="destructive" className="m-4 w-auto">
					<AlertDescription>{t("hostPlugins.failed", { code: error })}</AlertDescription>
				</Alert>
			) : loading ? (
				<div role="status" className="flex items-center gap-2 p-4 text-muted-foreground">
					<LoaderCircle className="size-4 animate-pideck-spin" aria-hidden="true" />
					{t("common.loading")}
				</div>
			) : null}
		</div>
	);
}
