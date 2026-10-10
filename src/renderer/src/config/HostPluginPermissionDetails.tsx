/** One permission inventory feeds scaffold choices and consent; destinations must be visible before enabling. */
import type { HostPluginManifest } from "../../../shared/types/hostPlugin";
import { Alert, AlertDescription } from "../components/ui-shadcn/alert";
import { Badge } from "../components/ui-shadcn/badge";
import { t } from "../i18n";

export const HOST_PLUGIN_PERMISSION_OPTIONS = [
	["sessions.read", "hostPlugins.sessionsRead", "hostPlugins.scaffoldSessionsReadHint"],
	["workbench.navigate", "hostPlugins.scaffoldNavigate", "hostPlugins.scaffoldNavigateHint"],
	["workbench.openExternal", "hostPlugins.scaffoldOpenExternal", "hostPlugins.scaffoldOpenExternalHint"],
	["network.https", "hostPlugins.networkHttps", "hostPlugins.networkHttpsHint"],
	["network.local", "hostPlugins.networkLocal", "hostPlugins.networkLocalHint"],
] as const;

/** Never collapse grants into “can access the network”: the exact origins and loopback ports are the consent. */
export function HostPluginPermissionDetails({ manifest, warnings = false }: { manifest: HostPluginManifest; warnings?: boolean }) {
	const network = manifest.permissions.includes("network.https") || manifest.permissions.includes("network.local");
	return (
		<div className="flex flex-col items-start gap-2">
			{HOST_PLUGIN_PERMISSION_OPTIONS.filter(([permission]) => manifest.permissions.includes(permission)).map(([permission, label]) => (
				<Badge key={permission} variant="outline">
					{t(label)}
				</Badge>
			))}
			{!manifest.permissions.includes("sessions.read") && <Badge variant="outline">{t("hostPlugins.noSessionsRead")}</Badge>}
			{network && (
				<div className="flex w-full flex-col gap-1 text-xs">
					<span className="text-muted-foreground">{t("hostPlugins.networkDestinations")}</span>
					<ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
						{manifest.network?.httpsOrigins?.map((origin) => (
							<li key={origin} className="shrink-0 break-all font-mono">
								{origin}
							</li>
						))}
						{manifest.network?.localPorts?.map((port) => (
							<li key={port} className="shrink-0 break-all font-mono">{`http://127.0.0.1:${port}`}</li>
						))}
					</ul>
				</div>
			)}
			{warnings && network && manifest.permissions.includes("sessions.read") && (
				<Alert variant="destructive">
					<AlertDescription>{t("hostPlugins.networkDataWarning")}</AlertDescription>
				</Alert>
			)}
			{warnings && manifest.permissions.includes("network.local") && (
				<Alert>
					<AlertDescription>{t("hostPlugins.networkLocalWarning")}</AlertDescription>
				</Alert>
			)}
		</div>
	);
}
