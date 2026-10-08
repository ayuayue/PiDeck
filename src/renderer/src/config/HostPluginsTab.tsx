import { useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { FolderOpen, RefreshCw, Puzzle } from "lucide-react";
import type { HostPluginInfo } from "../../../shared/types/hostPlugin";
import { hostPluginCatalogAtom, hostPluginPanelAtom } from "../atoms/host-plugin-atoms";
import { settingsOpenAtom } from "../atoms/app-ui-atoms";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { Alert, AlertDescription } from "../components/ui-shadcn/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui-shadcn/alert-dialog";
import { Badge } from "../components/ui-shadcn/badge";
import { Button } from "../components/ui-shadcn/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui-shadcn/table";

/** Desktop-owned plugins are global packages with project-scoped data grants, separate from pi extensions. */
export function HostPluginsTab() {
	const { catalog, error } = useAtomValue(hostPluginCatalogAtom);
	const setCatalog = useSetAtom(hostPluginCatalogAtom);
	const openPanel = useSetAtom(hostPluginPanelAtom);
	const setSettingsOpen = useSetAtom(settingsOpenAtom);
	const [consent, setConsent] = useState<HostPluginInfo | null>(null);
	const [busy, setBusy] = useState(false);
	const fail = (code: string) => showNotice(t("hostPlugins.failed", { code }), 4500, "error");
	const rescan = async () => {
		setBusy(true);
		try {
			const result = await desktopApi.hostPlugins.rescan();
			if (result.ok) setCatalog({ catalog: result.value });
			else fail(result.code);
		} catch {
			fail("plugin-host-unavailable");
		} finally {
			setBusy(false);
		}
	};
	const toggle = async (plugin: HostPluginInfo, enabled: boolean) => {
		setBusy(true);
		try {
			const result = await desktopApi.hostPlugins.setEnabled(plugin.manifest.id, enabled, plugin.fingerprint);
			if (result.ok) setCatalog({ catalog: result.value });
			else fail(result.code);
		} catch {
			fail("plugin-host-unavailable");
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="flex flex-col gap-4">
			<Alert>
				<Puzzle />
				<AlertDescription>{t("hostPlugins.description")}</AlertDescription>
			</Alert>
			<div className="flex flex-wrap items-center gap-2">
				<Button variant="outline" size="sm" disabled={busy} onClick={() => void rescan()}>
					<RefreshCw data-icon="inline-start" />
					{t("hostPlugins.rescan")}
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={!catalog}
					onClick={() =>
						void desktopApi.hostPlugins
							.openDirectory()
							.then((result) => {
								if (!result.ok) fail(result.code);
							})
							.catch(() => fail("plugin-host-unavailable"))
					}
				>
					<FolderOpen data-icon="inline-start" />
					{t("hostPlugins.openDirectory")}
				</Button>
				{catalog && <span className="break-all text-xs text-muted-foreground">{catalog.directory}</span>}
			</div>
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{t("hostPlugins.failed", { code: error })}</AlertDescription>
				</Alert>
			)}
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>{t("hostPlugins.plugin")}</TableHead>
						<TableHead>{t("hostPlugins.permission")}</TableHead>
						<TableHead>{t("hostPlugins.actions")}</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{catalog?.plugins.map((plugin) => (
						<TableRow key={plugin.manifest.id}>
							<TableCell>
								<div className="flex flex-col gap-1">
									<strong>{plugin.manifest.name}</strong>
									<span className="text-xs text-muted-foreground">
										{plugin.manifest.id} / {plugin.manifest.version}
									</span>
									{plugin.manifest.description && <span className="text-xs text-muted-foreground">{plugin.manifest.description}</span>}
								</div>
							</TableCell>
							<TableCell>
								<div className="flex flex-col items-start gap-2">
									<Badge variant="outline">{t(plugin.manifest.permissions.includes("sessions.read") ? "hostPlugins.sessionsRead" : "hostPlugins.noSessionsRead")}</Badge>
									<Badge variant="secondary">{t(plugin.enabled ? "hostPlugins.enabled" : plugin.requiresConsent ? "hostPlugins.changed" : "hostPlugins.disabled")}</Badge>
								</div>
							</TableCell>
							<TableCell>
								<div className="flex flex-wrap gap-2">
									<Button
										size="sm"
										variant="outline"
										disabled={busy}
										onClick={() => {
											if (plugin.enabled) void toggle(plugin, false);
											else setConsent(plugin);
										}}
									>
										{t(plugin.enabled ? "hostPlugins.disable" : "hostPlugins.enable")}
									</Button>
									{plugin.enabled &&
										plugin.manifest.contributes.panels.map((panel) => (
											<Button
												key={panel.id}
												size="sm"
												variant="secondary"
												onClick={() => {
													setSettingsOpen(false);
													openPanel({ pluginId: plugin.manifest.id, panelId: panel.id });
												}}
											>
												{panel.title}
											</Button>
										))}
								</div>
							</TableCell>
						</TableRow>
					))}
					{catalog && catalog.plugins.length === 0 && (
						<TableRow>
							<TableCell colSpan={3}>{t("hostPlugins.empty")}</TableCell>
						</TableRow>
					)}
				</TableBody>
			</Table>
			{catalog?.issues.map((issue) => (
				<Alert key={`${issue.directory}:${issue.code}`} variant="destructive">
					<AlertDescription>{t("hostPlugins.packageRejected", { directory: issue.directory, code: issue.code })}</AlertDescription>
				</Alert>
			))}
			<AlertDialog
				open={Boolean(consent)}
				onOpenChange={(open) => {
					if (!open) setConsent(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("hostPlugins.consentTitle", { name: consent?.manifest.name ?? "" })}</AlertDialogTitle>
						<AlertDialogDescription>{t("hostPlugins.consentDescription")}</AlertDialogDescription>
					</AlertDialogHeader>
					<p className="text-sm">{t(consent?.manifest.permissions.includes("sessions.read") ? "hostPlugins.sessionsRead" : "hostPlugins.noSessionsRead")}</p>
					<p className="break-all text-xs text-muted-foreground">{consent?.fingerprint}</p>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							disabled={busy}
							onClick={() => {
								if (consent) void toggle(consent, true);
							}}
						>
							{t("hostPlugins.enable")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</section>
	);
}
