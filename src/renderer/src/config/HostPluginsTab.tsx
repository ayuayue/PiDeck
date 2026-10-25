import { useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { FolderOpen, FolderPlus, PackagePlus, RefreshCw, Puzzle, BookOpen, FilePlus2, ChevronDown, Link2, Plus, LoaderCircle } from "lucide-react";
import type { HostPluginCatalog, HostPluginInfo, HostPluginPermission } from "../../../shared/types/hostPlugin";
import { LOCAL_SERVICE_IDS } from "../../../shared/localServices";
import { hostPluginCatalogAtom, hostPluginPanelAtom } from "../atoms/host-plugin-atoms";
import { settingsOpenAtom } from "../atoms/app-ui-atoms";
import { desktopApi } from "../desktopApi";
import { t, type TranslationKey } from "../i18n";
import { showNotice } from "../utils/notice";
import { Alert, AlertDescription } from "../components/ui-shadcn/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui-shadcn/alert-dialog";
import { Button } from "../components/ui-shadcn/button";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui-shadcn/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui-shadcn/dialog";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui-shadcn/select";
import { HostPluginRow } from "./HostPluginRow";
import { HOST_PLUGIN_PERMISSION_OPTIONS, HostPluginPermissionDetails } from "./HostPluginPermissionDetails";
import { hostPluginScaffoldInput, initialHostPluginScaffoldDraft } from "./hostPluginScaffoldDraft";

/** 安装/操作失败码 → 可执行的中文提示；未列出的码回退到带码的通用文案。 */
const PLUGIN_ERROR_KEYS: Record<string, TranslationKey> = {
	"invalid-github-url": "hostPlugins.errorInvalidGitHubUrl",
	"plugin-not-found": "hostPlugins.errorPluginNotFound",
	"missing-manifest": "hostPlugins.errorMissingManifest",
	"plugin-manifest-ambiguous": "hostPlugins.errorAmbiguousManifest",
	"download-failed": "hostPlugins.errorDownloadFailed",
	"archive-too-large": "hostPlugins.errorArchiveTooLarge",
	"package-too-large": "hostPlugins.errorPackageTooLarge",
	"plugin-in-use": "hostPlugins.errorPluginInUse",
	"invalid-package-file": "hostPlugins.errorInvalidPackageFile",
	"asset-too-large": "hostPlugins.errorAssetTooLarge",
};

/** Desktop-owned plugins are global packages with project-scoped data grants, separate from pi extensions. */
export function HostPluginsTab() {
	const { catalog, error } = useAtomValue(hostPluginCatalogAtom);
	const setCatalog = useSetAtom(hostPluginCatalogAtom);
	const openPanel = useSetAtom(hostPluginPanelAtom);
	const setSettingsOpen = useSetAtom(settingsOpenAtom);
	const [consent, setConsent] = useState<HostPluginInfo | null>(null);
	// 卸载确认：删目录不可逆，与启用授权一样走一次显式确认。
	const [removing, setRemoving] = useState<HostPluginInfo | null>(null);
	const [busy, setBusy] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	// GitHub 安装：链接只能由用户粘贴（渲染层不能传路径），失败码单独给可执行提示。
	const [githubOpen, setGithubOpen] = useState(false);
	const [githubUrl, setGithubUrl] = useState("");
	// 默认勾上一个最常见的权限：新手生成的示例直接能看到内容，而不是一打开就报权限错误。
	const [draft, setDraft] = useState(initialHostPluginScaffoldDraft);
	const fail = (code: string) => {
		const key = PLUGIN_ERROR_KEYS[code];
		showNotice(key ? t(key) : t("hostPlugins.failed", { code }), 4500, "error");
	};
	const applyCatalog = (catalog: HostPluginCatalog) => setCatalog({ catalog });
	const rescan = async () => {
		setBusy(true);
		try {
			const result = await desktopApi.hostPlugins.rescan();
			if (result.ok) applyCatalog(result.value);
			else fail(result.code);
		} catch {
			fail("plugin-host-unavailable");
		} finally {
			setBusy(false);
		}
	};
	const openPluginDirectory = () => {
		void desktopApi.hostPlugins
			.openDirectory()
			.then((result) => {
				if (!result.ok) fail(result.code);
			})
			.catch(() => fail("plugin-host-unavailable"));
	};
	/** 归档与目录两个来源共用：失败码里只有 canceled 是正常取消，不弹错误。 */
	const install = async (source: "archive" | "directory") => {
		setBusy(true);
		try {
			const result = source === "archive" ? await desktopApi.hostPlugins.install() : await desktopApi.hostPlugins.installDirectory();
			if (result.ok) {
				applyCatalog(result.value);
				showNotice(t("hostPlugins.installSuccess"), 4500, "info");
			} else if (result.code !== "canceled") fail(result.code);
		} catch {
			fail("plugin-host-unavailable");
		} finally {
			setBusy(false);
		}
	};
	/** GitHub：下载与解包全在主进程，这里只把链接递过去；成功后关闭弹窗并清空输入。 */
	const installFromGitHub = async () => {
		const url = githubUrl.trim();
		if (!url) return;
		setBusy(true);
		try {
			const result = await desktopApi.hostPlugins.installGitHub(url);
			if (result.ok) {
				applyCatalog(result.value);
				setGithubOpen(false);
				setGithubUrl("");
				showNotice(t("hostPlugins.installSuccess"), 4500, "info");
			} else fail(result.code);
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
			if (result.ok) applyCatalog(result.value);
			else fail(result.code);
		} catch {
			fail("plugin-host-unavailable");
		} finally {
			setBusy(false);
		}
	};
	/** 卸载：删掉插件目录并清掉授权；内置示例会被主进程拒（plugin-builtin），提示用户改用禁用。 */
	const remove = async (plugin: HostPluginInfo) => {
		setBusy(true);
		try {
			const result = await desktopApi.hostPlugins.remove(plugin.manifest.id);
			if (result.ok) {
				applyCatalog(result.value);
				showNotice(t("hostPlugins.removed", { name: plugin.manifest.name }), 4500, "info");
			} else fail(result.code);
		} catch {
			fail("plugin-host-unavailable");
		} finally {
			setBusy(false);
			setRemoving(null);
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
				applyCatalog(result.value);
				setCreateOpen(false);
				showNotice(t("hostPlugins.scaffoldCreated", { id: draft.id }), 6000, "info");
			} else fail(result.code);
		} catch {
			fail("plugin-host-unavailable");
		} finally {
			setBusy(false);
		}
	};
	const togglePermission = (permission: HostPluginPermission, checked: boolean) =>
		setDraft((current) => ({
			...current,
			permissions: checked ? [...current.permissions, permission] : current.permissions.filter((item) => item !== permission),
			// 勾上服务控制时预置 PiDeck 已实现的服务（作者仍可逐个取消）；不预置会因缺 services 被 manifest 校验拒。
			...(permission === "service.local" && checked && current.services.length === 0 ? { services: [...LOCAL_SERVICE_IDS] } : {}),
		}));
	const draftReady = hostPluginScaffoldInput(draft) !== null;
	return (
		<section className="flex flex-col gap-4">
			<Alert>
				<Puzzle />
				<AlertDescription>{t("hostPlugins.description")}</AlertDescription>
			</Alert>
			<div className="flex flex-wrap items-center gap-2">
				{/* 安装是主操作：三种来源共用一个入口，避开四个同权重按钮排成一行。 */}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button size="sm" disabled={busy}>
							<Plus data-icon="inline-start" />
							{t("hostPlugins.installMenu")}
							<ChevronDown size={14} aria-hidden="true" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="min-w-[13rem]">
						<DropdownMenuItem onClick={() => void install("archive")}>
							<PackagePlus size={14} aria-hidden="true" />
							{t("hostPlugins.install")}
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => void install("directory")}>
							<FolderPlus size={14} aria-hidden="true" />
							{t("hostPlugins.installDirectory")}
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => setGithubOpen(true)}>
							<Link2 size={14} aria-hidden="true" />
							{t("hostPlugins.installGitHub")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
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
				<Button variant="ghost" size="sm" disabled={busy} onClick={() => void rescan()}>
					<RefreshCw data-icon="inline-start" />
					{t("hostPlugins.rescan")}
				</Button>
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
			{/* 安装目录满宽单独一行：路径完整可读、可就地打开，不再和按钮抢一行宽度。 */}
			{catalog && (
				<div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
					<span className="min-w-0 truncate font-mono" title={catalog.directory}>
						{catalog.directory}
					</span>
					<Button variant="link" size="sm" className="h-auto shrink-0 gap-1 px-0 text-xs font-normal" onClick={openPluginDirectory}>
						<FolderOpen size={12} aria-hidden="true" />
						{t("hostPlugins.openDirectory")}
					</Button>
				</div>
			)}
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{t("hostPlugins.failed", { code: error })}</AlertDescription>
				</Alert>
			)}
			{/* 行式列表而非表格：权限只列标签名，长描述/多标签/操作按钮都能自然换行，不再被三列比例挤压。 */}
			<div className="flex flex-col gap-2">
				{catalog?.plugins.map((plugin) => (
					<HostPluginRow
						key={plugin.manifest.id}
						plugin={plugin}
						busy={busy}
						onToggle={(target) => {
							if (target.enabled) void toggle(target, false);
							else setConsent(target);
						}}
						onRemove={setRemoving}
						onOpenPanel={(pluginId, panelId) => {
							setSettingsOpen(false);
							openPanel({ pluginId, panelId });
						}}
					/>
				))}
				{catalog && catalog.plugins.length === 0 && (
					<div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-10 text-center">
						<Puzzle size={20} className="text-muted-foreground" aria-hidden="true" />
						<span className="max-w-[36rem] text-xs leading-relaxed text-muted-foreground">{t("hostPlugins.empty")}</span>
						<Button variant="outline" size="sm" disabled={busy} onClick={() => void install("archive")}>
							<PackagePlus data-icon="inline-start" />
							{t("hostPlugins.install")}
						</Button>
					</div>
				)}
			</div>
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
			<AlertDialog
				open={Boolean(removing)}
				onOpenChange={(open) => {
					if (!open) setRemoving(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("hostPlugins.removeConfirmTitle", { name: removing?.manifest.name ?? "" })}</AlertDialogTitle>
						<AlertDialogDescription>{t("hostPlugins.removeConfirmDescription")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							disabled={busy}
							onClick={() => {
								if (removing) void remove(removing);
							}}
						>
							{t("hostPlugins.remove")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			{/* GitHub 安装：链接只在主进程解析与下载，渲染层只负责输入与结果反馈；仓库里的其他内容不会被执行。 */}
			<Dialog
				open={githubOpen}
				onOpenChange={(open) => {
					setGithubOpen(open);
					if (!open) setGithubUrl("");
				}}
			>
				<DialogContent className="max-w-[min(560px,calc(100vw-48px))]">
					<DialogHeader>
						<DialogTitle>{t("hostPlugins.githubTitle")}</DialogTitle>
						<DialogDescription>{t("hostPlugins.githubDescription")}</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="host-plugin-github-url">{t("hostPlugins.githubUrlLabel")}</Label>
						<Input
							id="host-plugin-github-url"
							spellCheck={false}
							className="font-mono"
							placeholder={t("hostPlugins.githubUrlPlaceholder")}
							aria-describedby="host-plugin-github-url-hint"
							value={githubUrl}
							onChange={(event) => setGithubUrl(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && githubUrl.trim() && !busy) void installFromGitHub();
							}}
						/>
						<span id="host-plugin-github-url-hint" className="text-xs text-muted-foreground">
							{t("hostPlugins.githubUrlHint")}
						</span>
					</div>
					<DialogFooter>
						<Button variant="ghost" size="sm" onClick={() => setGithubOpen(false)}>
							{t("common.cancel")}
						</Button>
						<Button size="sm" disabled={busy || !githubUrl.trim()} onClick={() => void installFromGitHub()}>
							{busy ? <LoaderCircle className="size-4 animate-pideck-spin" aria-hidden="true" /> : <Link2 className="size-4" aria-hidden="true" />}
							{t("hostPlugins.githubInstall")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
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
						{draft.permissions.includes("service.local") && (
							<div className="flex flex-col gap-2">
								<Label>{t("hostPlugins.scaffoldServices")}</Label>
								{LOCAL_SERVICE_IDS.map((id) => (
									<div key={id} className="flex items-start gap-2">
										<Checkbox id={`host-plugin-service-${id}`} checked={draft.services.includes(id)} onCheckedChange={(value) => setDraft((current) => ({ ...current, services: value === true ? [...current.services, id] : current.services.filter((item) => item !== id) }))} />
										<Label htmlFor={`host-plugin-service-${id}`} className="cursor-pointer font-mono text-sm">
											{id}
										</Label>
									</div>
								))}
								<span className="text-xs text-muted-foreground">{t("hostPlugins.scaffoldServicesHint")}</span>
							</div>
						)}
						<div className="flex flex-col gap-1.5">
							<Label>{t("hostPlugins.scaffoldPresentation")}</Label>
							<Select value={draft.presentation} onValueChange={(value) => setDraft((current) => ({ ...current, presentation: value === "page" || value === "popover" ? value : "modal" }))}>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="modal">{t("hostPlugins.scaffoldModal")}</SelectItem>
									<SelectItem value="popover">{t("hostPlugins.scaffoldPopover")}</SelectItem>
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
