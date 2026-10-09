import { useRef } from "react";
import { useHostPluginView } from "../../hooks/plugins/useHostPluginView";
import { t } from "../../i18n";
import { Alert, AlertDescription } from "../ui-shadcn/alert";
import { LoaderCircle } from "lucide-react";

/** Keep host loading/errors outside the native page; a plugin crash does not replace the workbench. */
export function HostPluginSurface({ pluginId, panelId, projectId, sessionId }: { pluginId: string; panelId: string; projectId?: string; sessionId?: string }) {
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
