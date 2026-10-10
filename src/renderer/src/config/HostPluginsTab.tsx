import { useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { FolderOpen, FolderPlus, PackagePlus, RefreshCw, Puzzle, BookOpen, FilePlus2 } from "lucide-react";
import type { HostPluginInfo, HostPluginPermission } from "../../../shared/types/hostPlugin";
import { hostPluginCatalogAtom, hostPluginPanelAtom } from "../atoms/host-plugin-atoms";
import { settingsOpenAtom } from "../atoms/app-ui-atoms";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { Alert, AlertDescription } from "../components/ui-shadcn/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui-shadcn/alert-dialog";
import { Badge } from "../components/ui-shadcn/badge";
import { Button } from "../components/ui-shadcn/button";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui-shadcn/dialog";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui-shadcn/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui-shadcn/table";
import { HOST_PLUGIN_PERMISSION_OPTIONS, HostPluginPermissionDetails } from "./HostPluginPermissionDetails";
import { hostPluginScaffoldInput, initialHostPluginScaffoldDraft } from "./hostPluginScaffoldDraft";

/** Desktop-owned plugins are global packages with project-scoped data grants, separate from pi extensions. */
export function HostPluginsTab() {
	const { catalog, error } = useAtomValue(hostPluginCatalogAtom);
	const setCatalog = useSetAtom(hostPluginCatalogAtom);
	const openPanel = useSetAtom(hostPluginPanelAtom);
	const setSettingsOpen = useSetAtom(settingsOpenAtom);
	const [consent, setConsent] = useState<HostPluginInfo | null>(null);
	const [busy, setBusy] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	// 默认勾上一个最常见的权限：新手生成的示例直接能看到内容，而不是一打开就报权限错误。
	const [draft, setDraft] = useState(initialHostPluginScaffoldDraft);
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
	/** 归档与目录两个来源共用：失败码里只有 canceled 是正常取消，不弹错误。 */
	const install = async (source: "archive" | "directory") => {
		setBusy(true);
		try {
			const result = source === "archive" ? await desktopApi.hostPlugins.install() : await desktopApi.hostPlugins.installDirectory();
			if (result.ok) {
				setCatalog({ catalog: result.value });
				showNotice(t("hostPlugins.installSuccess"), 4500, "info");
			} else if (result.code !== "canceled") fail(result.code);
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
	/** 脚手架：先落盘再重扫描，生成的插件直接出现在下表里（默认禁用，仍需授权启用）。 */
	const scaffold = async () => {
		const input = hostPluginScaffoldInput(draft);
		if (!input) return;
		setBusy(true);
		try {
			const result = await desktopApi.hostPlugins.scaffold(input);
			if (result.ok) {
				setCatalog({ catalog: result.value });
				setCreateOpen(false);
				showNotice(t("hostPlugins.scaffoldCreated", { id: draft.id }), 6000, "info");
			} else fail(result.code);
		} catch {
			fail("plugin-host-unavailable");
		} finally {
			setBusy(false);
		}
	};
	const togglePermission = (permission: HostPluginPermission, checked: boolean) => setDraft((current) => ({ ...current, permissions: checked ? [...current.permissions, permission] : current.permissions.filter((item) => item !== permission) }));
	const draftReady = hostPluginScaffoldInput(draft) !== null;
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
				<Button variant="outline" size="sm" disabled={busy} onClick={() => void install("archive")}>
					<PackagePlus data-icon="inline-start" />
					{t("hostPlugins.install")}
				</Button>
				<Button variant="outline" size="sm" disabled={busy} onClick={() => void install("directory")}>
					<FolderPlus data-icon="inline-start" />
					{t("hostPlugins.installDirectory")}
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={busy}
					onClick={() => {
						setDraft(initialHostPluginScaffoldDraft());
						setCreateOpen(true);
					}}
				>
					<FilePlus2 data-icon="inline-start" />
					{t("hostPlugins.scaffold")}
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
				<span className="flex-1" />
				{/* 开发指南外链：指向仓库内的单一数据源（docs/host-plugin-dev-guide.md），与插件作者所见一致 */}
				<Button
					variant="ghost"
					size="sm"
					onClick={() => {
						void desktopApi.app.openExternal("https://github.com/ayuayue/PiDeck/blob/main/docs/host-plugin-dev-guide.md", true).catch(() => fail("plugin-host-unavailable"));
					}}
				>
					<BookOpen data-icon="inline-start" />
					{t("hostPlugins.devGuide")}
				</Button>
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
									<HostPluginPermissionDetails manifest={plugin.manifest} />
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
				<AlertDialogContent className="max-h-[calc(100vh-64px)] overflow-y-auto">
					<AlertDialogHeader>
						<AlertDialogTitle>{t("hostPlugins.consentTitle", { name: consent?.manifest.name ?? "" })}</AlertDialogTitle>
						<AlertDialogDescription>{t("hostPlugins.consentDescription")}</AlertDialogDescription>
					</AlertDialogHeader>
					{consent && <HostPluginPermissionDetails manifest={consent.manifest} warnings />}
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
			{/* 只生成静态页面与示例 JS，不执行生成物、不启动服务；网络目的地随后仍需显式授权。 */}
			<Dialog open={createOpen} onOpenChange={setCreateOpen}>
				<DialogContent className="flex max-h-[calc(100vh-64px)] max-w-[min(600px,calc(100vw-48px))] flex-col gap-4 overflow-y-auto">
					<DialogHeader>
						<DialogTitle>{t("hostPlugins.scaffoldTitle")}</DialogTitle>
						<DialogDescription>{t("hostPlugins.scaffoldDescription")}</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="host-plugin-scaffold-id">{t("hostPlugins.scaffoldId")}</Label>
							<Input id="host-plugin-scaffold-id" spellCheck={false} className="font-mono" placeholder="my-plugin" value={draft.id} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value.trim().toLowerCase() }))} />
							<span className="text-xs text-muted-foreground">{t("hostPlugins.scaffoldIdHint")}</span>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="host-plugin-scaffold-name">{t("hostPlugins.scaffoldName")}</Label>
							<Input id="host-plugin-scaffold-name" placeholder="My Plugin" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
						</div>
						<div className="flex flex-col gap-2">
							<Label>{t("hostPlugins.scaffoldPermissions")}</Label>
							{HOST_PLUGIN_PERMISSION_OPTIONS.map(([permission, label, hint]) => {
								const checked = draft.permissions.includes(permission);
								return (
									<div key={permission} className="flex items-start gap-2">
										<Checkbox id={`host-plugin-permission-${permission}`} checked={checked} onCheckedChange={(value) => togglePermission(permission, value === true)} />
										<Label htmlFor={`host-plugin-permission-${permission}`} className="flex cursor-pointer flex-col items-start gap-0.5 text-left">
											<span className="text-sm">{t(label)}</span>
											<span className="text-xs font-normal text-muted-foreground">{t(hint)}</span>
										</Label>
									</div>
								);
							})}
						</div>
						{draft.permissions.includes("network.https") && (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="host-plugin-https-origins">{t("hostPlugins.httpsOrigins")}</Label>
								<Input id="host-plugin-https-origins" spellCheck={false} className="font-mono" placeholder="https://api.example.com" aria-describedby="host-plugin-https-hint" value={draft.httpsOrigins} onChange={(event) => setDraft((current) => ({ ...current, httpsOrigins: event.target.value }))} />
								<span id="host-plugin-https-hint" className="text-xs text-muted-foreground">
									{t("hostPlugins.httpsOriginsHint")}
								</span>
							</div>
						)}
						{draft.permissions.includes("network.local") && (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="host-plugin-local-ports">{t("hostPlugins.localPorts")}</Label>
								<Input id="host-plugin-local-ports" spellCheck={false} className="font-mono" placeholder="4187" aria-describedby="host-plugin-local-hint" value={draft.localPorts} onChange={(event) => setDraft((current) => ({ ...current, localPorts: event.target.value }))} />
								<span id="host-plugin-local-hint" className="text-xs text-muted-foreground">
									{t("hostPlugins.localPortsHint")}
								</span>
							</div>
						)}
						<div className="flex flex-col gap-1.5">
							<Label>{t("hostPlugins.scaffoldPresentation")}</Label>
							<Select value={draft.presentation} onValueChange={(value) => setDraft((current) => ({ ...current, presentation: value === "page" ? "page" : "modal" }))}>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="modal">{t("hostPlugins.scaffoldModal")}</SelectItem>
									<SelectItem value="page">{t("hostPlugins.scaffoldPage")}</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</div>
					<DialogFooter>
						<Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>
							{t("common.cancel")}
						</Button>
						<Button size="sm" disabled={busy || !draftReady} onClick={() => void scaffold()}>
							{t("hostPlugins.scaffoldCreate")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</section>
	);
}
