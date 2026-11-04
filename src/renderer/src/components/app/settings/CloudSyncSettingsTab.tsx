import { useCallback, useState } from "react";
import {
	ChevronDown,
	ChevronRight,
	Cloud,
	Download,
	Folder,
	FolderOpen,
	KeyRound,
	Lock,
	Plus,
	RefreshCw,
	Settings2,
	ShieldCheck,
	TriangleAlert,
	Upload,
} from "lucide-react";
import { t, type TranslationKey } from "../../../i18n";
import { useCloudSync } from "../../../hooks/useCloudSync";
import { useCloudSyncSelection } from "../../../hooks/useCloudSyncSelection";
import { useCloudSyncBackup } from "../../../hooks/useCloudSyncBackup";
import {
	useGithubDeviceFlow,
	useOneDriveFlow,
	useGoogleFlow,
} from "../../../hooks/useCloudSyncProviderFlows";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingBox } from "./SettingRows";
import { CloudSyncPasswordForm } from "./CloudSyncPasswordForm";
import {
	GithubProviderCard,
	GoogleProviderCard,
	LocalFolderProviderCard,
	OneDriveProviderCard,
	ProviderCard,
} from "./CloudSyncProviderCards";
import { Field, SecretInput, StatusDot } from "./CloudSyncProviderShell";
import { GLOBAL_SYNC_PROJECT_ID, ProjectSelectionNode } from "./CloudSyncSelectionTree";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui-shadcn/tabs";
import type {
	CloudSyncContentPreferences,
	CloudSyncProviderConfigInput,
	CloudSyncResourceCategory,
	CloudSyncSelectionTree,
} from "../../../../../shared/types";
import { cn } from "../../../lib/utils";

/** 全局配置分类开关：密钥/模型/生图随加密载荷同步；DSH 未实现时禁用。 */
const CONTENT_CATEGORIES: Array<{
	key: keyof CloudSyncContentPreferences | "agentSettings" | "looseConfig";
	labelKey: TranslationKey;
	descKey?: TranslationKey;
	supported: boolean;
	/** 资源类别联动：开关状态 = 全局树该类别全选，切换即批量全选/全不选。 */
	resourceCategory?: CloudSyncResourceCategory;
}> = [
	{ key: "desktopSettings", labelKey: "cloudSync.content.catDesktopSettings", descKey: "cloudSync.content.catDesktopSettingsDesc", supported: true },
	{ key: "piModels", labelKey: "cloudSync.content.catPiModels", descKey: "cloudSync.content.catPiModelsDesc", supported: true },
	{ key: "piCredentials", labelKey: "cloudSync.content.catPiCredentials", descKey: "cloudSync.content.catPiCredentialsDesc", supported: true },
	{ key: "imageGen", labelKey: "cloudSync.content.catImageGen", descKey: "cloudSync.content.catImageGenDesc", supported: true },
	{ key: "agentSettings", labelKey: "cloudSync.content.catAgentSettings", descKey: "cloudSync.content.catAgentSettingsDesc", supported: true, resourceCategory: "settings" },
	{ key: "looseConfig", labelKey: "cloudSync.content.catLooseConfig", descKey: "cloudSync.content.catLooseConfigDesc", supported: true, resourceCategory: "config" },
	{ key: "dshSettings", labelKey: "cloudSync.content.catDshSettings", supported: false },
	{ key: "dshCredentials", labelKey: "cloudSync.content.catDshCredentials", supported: false },
];

/** 云同步设置页：主密码 → Provider → 选择树 → 同步（装配层，域逻辑在 useCloudSync* 系列 hook）。 */
export function CloudSyncSettingsTab() {
	const cloudSync = useCloudSync();
	const {
		state,
		tree,
		busy,
		error,
		setupMasterKey,
		unlock,
		lock,
		configureProvider,
		disconnectProvider,
		scan,
		syncNow,
		restoreExtensions,
		connect,
		setAutoSync,
		setStrategy,
	} = cloudSync;

	// 域 hook：选择集合 / 备份表单 / 三套 OAuth 授权流程（窄接口透传，不重复订阅）。
	const selection = useCloudSyncSelection(cloudSync);
	const backup = useCloudSyncBackup(cloudSync);
	const github = useGithubDeviceFlow(cloudSync);
	const onedrive = useOneDriveFlow(cloudSync);
	const google = useGoogleFlow(cloudSync);

	const securityState = state?.securityState ?? "NO_KEY";
	const unlocked = securityState === "UNLOCKED";

	/** 折叠的项目节点；全局默认展开，其余默认收起。 */
	const [expandedProjectIds, setExpandedProjectIds] = useState<ReadonlySet<string>>(new Set([GLOBAL_SYNC_PROJECT_ID]));

	const selectionTree = tree as CloudSyncSelectionTree | null;

	const toggleExpanded = useCallback((projectId: string) => {
		setExpandedProjectIds((prev) => {
			const next = new Set(prev);
			if (next.has(projectId)) next.delete(projectId);
			else next.add(projectId);
			return next;
		});
	}, []);

	const providers = state?.providers;
	const webdavSnapshot = providers?.webdav;
	const s3Snapshot = providers?.s3;
	const githubSnapshot = providers?.github;
	const localSnapshot = providers?.local;
	const onedriveSnapshot = providers?.onedrive;
	const googleSnapshot = providers?.google;

	const syncState = state?.syncState ?? "IDLE";
	const syncStatusDot = syncState === "SYNCING"
		? "connecting"
		: syncState === "IDLE"
			? "connected"
			: syncState === "ERROR" || syncState === "CONFLICT" || syncState === "BLOCKED"
				? "error"
				: "disconnected";
	const syncStatusLabel = t(`cloudSync.state.${syncState}` as TranslationKey);

	return (
		<div className="space-y-2">
			<Tabs defaultValue="providers" className="w-full">
				<TabsList className="mb-2 w-fit">
					<TabsTrigger value="providers">{t("cloudSync.tabs.providers")}</TabsTrigger>
					<TabsTrigger value="content">{t("cloudSync.tabs.content")}</TabsTrigger>
					<TabsTrigger value="backup">{t("cloudSync.backup.title")}</TabsTrigger>
				</TabsList>

				<TabsContent value="providers" className="mt-0">
					<SettingsSection title={t("cloudSync.security.title")} description={t("cloudSync.security.desc")} boxed={false}>
						{securityState === "NO_KEY" ? (
							<CloudSyncPasswordForm
								description={t("cloudSync.security.noKeyDesc")}
								submitLabel={t("cloudSync.security.setup")}
								confirm
								onSubmit={(password) => setupMasterKey(password)}
							/>
						) : securityState === "LOCKED" ? (
							<CloudSyncPasswordForm
								description={t("cloudSync.security.lockedDesc")}
								submitLabel={t("cloudSync.security.unlock")}
								onSubmit={(password) => unlock(password)}
							/>
						) : (
							<SettingBox>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<div className="flex items-center gap-2 text-body">
										<ShieldCheck size={16} className="text-success" />
										{t("cloudSync.security.unlocked")}
									</div>
									<div className="flex items-center gap-2">
										<Button size="sm" variant="outline" onClick={() => void lock()}>
											<Lock size={14} /> {t("cloudSync.security.lock")}
										</Button>
									</div>
								</div>
							</SettingBox>
						)}
					</SettingsSection>

					{unlocked ? (
						<>
							<SettingsSection title={t("cloudSync.provider.title")} description={t("cloudSync.provider.desc")} divided boxed={false}>
								<div className="mb-3 rounded-lg border border-border-subtle bg-background/40 p-3">
									<div className="text-sm font-medium">{t("cloudSync.provider.howToTitle")}</div>
									<div className="mt-0.5 text-caption text-text-tertiary">{t("cloudSync.provider.howToDesc")}</div>
									<div className="mt-2 space-y-2">
										<div>
											<span className="text-caption font-medium text-foreground/90">{t("cloudSync.provider.kind.oauth")}</span>
											<div className="text-caption text-text-tertiary">{t("cloudSync.provider.kind.oauthDesc")}</div>
										</div>
										<div>
											<span className="text-caption font-medium text-foreground/90">{t("cloudSync.provider.kind.config")}</span>
											<div className="text-caption text-text-tertiary">{t("cloudSync.provider.kind.configDesc")}</div>
										</div>
										<div>
											<span className="text-caption font-medium text-foreground/90">{t("cloudSync.provider.kind.folder")}</span>
											<div className="text-caption text-text-tertiary">{t("cloudSync.provider.kind.folderDesc")}</div>
											<div className="text-caption text-text-tertiary">{t("cloudSync.provider.kind.folderHint")}</div>
										</div>
									</div>
								</div>
								<div className="grid gap-3">
									<ProviderCard
										provider="webdav"
										icon={<Cloud size={16} className="text-primary" />}
										title={t("cloudSync.provider.webdavTitle")}
										description={t("cloudSync.provider.webdavDesc")}
										configured={Boolean(webdavSnapshot?.configured)}
										status={webdavSnapshot?.status ?? "disconnected"}
										account={webdavSnapshot?.account?.name}
										onConnect={(raw) => {
											const { provider, ...config } = raw as { provider: "webdav" | "s3"; [key: string]: unknown };
											// 主进程 parseProviderConfigInput 会重新校验形状/字段，这里只做形状适配。
											void configureProvider({ provider, config } as unknown as CloudSyncProviderConfigInput);
										}}
										onDisconnect={() => void disconnectProvider("webdav")}
										onReconnect={() => void connect("webdav")}
									/>
									<ProviderCard
										provider="s3"
										icon={<Settings2 size={16} className="text-primary" />}
										title={t("cloudSync.provider.s3Title")}
										description={t("cloudSync.provider.s3Desc")}
										configured={Boolean(s3Snapshot?.configured)}
										status={s3Snapshot?.status ?? "disconnected"}
										account={s3Snapshot?.account?.name}
										onConnect={(raw) => {
											const { provider, ...config } = raw as { provider: "webdav" | "s3"; [key: string]: unknown };
											// 主进程 parseProviderConfigInput 会重新校验形状/字段，这里只做形状适配。
											void configureProvider({ provider, config } as unknown as CloudSyncProviderConfigInput);
										}}
										onDisconnect={() => void disconnectProvider("s3")}
										onReconnect={() => void connect("s3")}
									/>
									<GithubProviderCard
										status={githubSnapshot?.status ?? "disconnected"}
										configured={Boolean(githubSnapshot?.configured)}
										builtin={Boolean(state?.oauthBuiltins?.github)}
										clientId={github.clientId}
										onClientIdChange={github.setClientId}
										onConnect={() => void github.start()}
										onDisconnect={() => void disconnectProvider("github")}
										onReconnect={() => void connect("github")}
										flow={github.flow}
										flowError={github.flowError}
									/>
									<LocalFolderProviderCard
										status={localSnapshot?.status ?? "disconnected"}
										configured={Boolean(localSnapshot?.configured)}
										onConnect={(folderPath) => {
											// 主进程 normalizeLocalFolderConfig 会校验绝对路径等约束。
											void configureProvider({ provider: "local", config: { folderPath } });
										}}
										onDisconnect={() => void disconnectProvider("local")}
										onReconnect={() => void connect("local")}
									/>
									<OneDriveProviderCard
										status={onedriveSnapshot?.status ?? "disconnected"}
										configured={Boolean(onedriveSnapshot?.configured)}
										builtin={Boolean(state?.oauthBuiltins?.onedrive)}
										clientId={onedrive.clientId}
										onClientIdChange={onedrive.setClientId}
										onStart={() => void onedrive.start()}
										onDisconnect={() => void disconnectProvider("onedrive")}
										onReconnect={() => void connect("onedrive")}
										flow={onedrive.flow}
										flowError={onedrive.flowError}
									/>
									<GoogleProviderCard
										status={googleSnapshot?.status ?? "disconnected"}
										configured={Boolean(googleSnapshot?.configured)}
										builtin={Boolean(state?.oauthBuiltins?.google)}
										clientId={google.clientId}
										clientSecret={google.clientSecret}
										onClientIdChange={google.setClientId}
										onClientSecretChange={google.setClientSecret}
										onStart={() => void google.start()}
										onDisconnect={() => void disconnectProvider("google")}
										onReconnect={() => void connect("google")}
										flow={google.flow}
										flowError={google.flowError}
									/>
								</div>
							</SettingsSection>

							<SettingsSection title={t("cloudSync.status.title")} divided boxed={false}>
								<SettingBox>
									<div className="flex flex-wrap items-center justify-between gap-3">
										<div className="flex items-center gap-3 text-sm">
											<span className="flex items-center gap-1.5">
												<StatusDot status={syncStatusDot} />
												{syncStatusLabel}
											</span>
											<span className="text-caption text-text-tertiary">{t("cloudSync.content.versions", { local: state?.localVersion ?? 0, remote: state?.remoteVersion ?? 0 })}</span>
											{state?.pendingLocalSync ? <span className="text-caption text-warning">{t("cloudSync.status.pending")}</span> : null}
										</div>
										<Button size="sm" onClick={() => void syncNow(false)} loading={busy}>
											<KeyRound size={14} /> {t("cloudSync.content.syncNow")}
										</Button>
									</div>
									{state?.lastError ? (
										<div className="mt-2 text-sm text-destructive">{state.lastError}</div>
									) : null}
									{error ? (
										<div className="mt-2 text-sm text-destructive">{error}</div>
									) : null}
								</SettingBox>
							</SettingsSection>
						</>
					) : null}
				</TabsContent>

				<TabsContent value="content" className="mt-0">
					{unlocked ? (
						<SettingsSection title={t("cloudSync.content.title")} description={t("cloudSync.content.desc")} boxed={false}>
							<SettingBox>
								<div className="flex flex-wrap items-center gap-3">
									<div className="flex items-center gap-2">
										<span className="text-sm">{t("cloudSync.content.strategy")}</span>
										<Select value={state?.syncStrategy ?? "smartMerge"} onValueChange={(value) => void setStrategy(value)}>
											<SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
											<SelectContent>
												<SelectItem value="smartMerge">{t("cloudSync.content.strategySmartMerge")}</SelectItem>
												<SelectItem value="preferCloud">{t("cloudSync.content.strategyPreferCloud")}</SelectItem>
												<SelectItem value="preferLocal">{t("cloudSync.content.strategyPreferLocal")}</SelectItem>
											</SelectContent>
										</Select>
									</div>
									<label className="flex cursor-pointer items-center gap-2 text-sm">
										<Checkbox
											checked={Boolean(state?.autoSyncEnabled)}
											onCheckedChange={(checked) => void setAutoSync(Boolean(checked), state?.autoSyncInterval ?? 5)}
										/>
										{t("cloudSync.content.autoSync")}
									</label>
									{/* 自动同步间隔（分钟）：值以主进程 snapshot 为准（无本地副本，避免漂移）；改动即时生效。 */}
									<div className="flex items-center gap-2">
										<span className="text-caption text-text-tertiary">{t("cloudSync.content.autoSyncInterval")}</span>
										<Select
											value={String(state?.autoSyncInterval ?? 5)}
											onValueChange={(value) => {
												const minutes = Number(value);
												void setAutoSync(Boolean(state?.autoSyncEnabled), minutes);
											}}
										>
											<SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
											<SelectContent>
												{[5, 10, 15, 30, 60].map((minutes) => (
													<SelectItem key={minutes} value={String(minutes)}>{minutes}</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
								</div>
								<div className="mt-3 flex flex-wrap items-center gap-2">
									<Button size="sm" onClick={() => void selection.handleScan()} loading={busy}>
										<RefreshCw size={14} /> {t("cloudSync.content.scan")}
									</Button>
									<Button size="sm" variant="outline" onClick={() => selection.handleToggleAll(selectionTree, true)}>{t("cloudSync.content.selectAll")}</Button>
									<Button size="sm" variant="outline" onClick={() => selection.handleToggleAll(selectionTree, false)}>{t("cloudSync.content.selectNone")}</Button>
									<Button size="sm" variant="outline" onClick={() => void selection.syncSelection(selectionTree)} disabled={!selectionTree} loading={busy}>
										{t("cloudSync.content.saveSelection")}
									</Button>
									<span className="flex-1" />
									<Button size="sm" variant="ghost" onClick={() => setExpandedProjectIds(new Set(selectionTree?.projects.map((project) => project.projectId) ?? []))} disabled={!selectionTree}>
										{t("cloudSync.content.expandAll")}
									</Button>
									<Button size="sm" variant="ghost" onClick={() => setExpandedProjectIds(new Set())} disabled={!selectionTree}>
										{t("cloudSync.content.collapseAll")}
									</Button>
								</div>
							</SettingBox>

							{selectionTree ? (
								<div className="mt-3 rounded-lg border border-border-subtle bg-background/40 p-3">
									<div className="mb-2 text-sm font-medium">{t("cloudSync.content.globalConfig")}</div>
									<div className="grid gap-1.5 sm:grid-cols-2">
										{CONTENT_CATEGORIES.map((category) => {
											const globalNode = selectionTree.projects.find((candidate) => candidate.projectId === GLOBAL_SYNC_PROJECT_ID);
											const linkedItems = category.resourceCategory
												? (globalNode?.resources.filter((resource) => resource.category === category.resourceCategory) ?? [])
												: [];
											// 联动开关：状态 = 全局树对应类别全选（无三态）；切换 = 批量全选/全不选。
											const linkedChecked = linkedItems.length > 0 && linkedItems.every((item) => selection.selectedResourceIds.has(item.selectionId));
											const checked = category.resourceCategory ? linkedChecked : Boolean(selectionTree.content[category.key as keyof CloudSyncContentPreferences]);
											const onToggle = (value: boolean) => {
												if (category.resourceCategory) {
													selection.toggleCategory(selectionTree, GLOBAL_SYNC_PROJECT_ID, category.resourceCategory, value);
												} else {
													selection.toggleContentCategory(category.key as keyof CloudSyncContentPreferences, value);
												}
											};
											return (
												<label
													key={category.key}
													className={cn(
														"flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50",
														!category.supported && "cursor-not-allowed opacity-60",
													)}
												>
													<Checkbox
														checked={checked}
														disabled={!category.supported}
														onCheckedChange={(value) => onToggle(Boolean(value))}
													/>
													<span className="min-w-0 flex-1">
														<span className="block truncate">{t(category.labelKey)}</span>
														{category.descKey ? <span className="block truncate text-caption text-text-tertiary">{t(category.descKey)}</span> : null}
													</span>
													{!category.supported ? <span className="shrink-0 text-caption text-text-tertiary">{t("cloudSync.content.notSupported")}</span> : null}
												</label>
											);
										})}
									</div>
									<div className="mt-2 text-caption text-text-tertiary">{t("cloudSync.content.globalConfigHint")}</div>
								</div>
							) : null}

							{selectionTree && selectionTree.projects.length > 0 ? (
								<div className="mt-3 max-h-96 space-y-2 overflow-y-auto rounded-lg border border-border-subtle bg-background/30 p-2">
									{selectionTree.projects.map((node) => (
										<ProjectSelectionNode
											key={node.projectId}
											node={node}
											expanded={expandedProjectIds.has(node.projectId)}
											onToggleExpanded={() => toggleExpanded(node.projectId)}
											onToggleSession={selection.toggleSession}
											onToggleResource={selection.toggleResource}
											onToggleNodeSessions={(projectId, all) => selection.toggleNodeSessions(selectionTree, projectId, all)}
											onToggleCategory={(projectId, category, selected) => selection.toggleCategory(selectionTree, projectId, category, selected)}
											onRemoveCustomPath={selection.onRemoveCustomPath}
											onMountProject={selection.onMountProject}
											sessionSelection={selection.selectedSessionIds}
											resourceSelection={selection.selectedResourceIds}
										/>
									))}
									<div className="pt-1">
										<Button size="sm" variant="outline" onClick={() => void selection.onAddCustomPath(selectionTree)}>
											<Plus size={14} /> {t("cloudSync.tree.addCustomPath")}
										</Button>
									</div>
								</div>
							) : (
								<div className="mt-3 text-caption text-text-tertiary">{t("cloudSync.content.empty")}</div>
							)}

							{state && state.mounts.length > 0 ? (
								<div className="mt-3 space-y-1 rounded-lg border border-border-subtle bg-background/30 p-2">
									<div className="px-1 text-caption font-medium text-text-tertiary">{t("cloudSync.tree.mounts")}</div>
									{state.mounts.map((mount) => (
										<div key={mount.remoteProjectId} className="flex items-center gap-2 px-1">
											<Folder size={14} className="shrink-0 text-text-tertiary" />
											<span className="min-w-0 flex-1 truncate text-sm text-foreground/70">
												<span className="font-medium">{mount.remoteProjectName}</span> → {mount.localPath}
											</span>
											<Button size="sm" variant="ghost" className="text-text-tertiary hover:text-destructive" onClick={() => selection.onUnmountProject(mount.remoteProjectId)}>
												{t("cloudSync.provider.remove")}
											</Button>
										</div>
									))}
								</div>
							) : null}

							{state && state.conflicts.length > 0 ? (
								<SettingBox>
									<div className="mb-2 text-sm font-medium">{t("cloudSync.conflict.title")}</div>
									<div className="mb-2 text-caption text-text-tertiary">{t("cloudSync.conflict.desc")}</div>
									<div className="space-y-2">
										{state.conflicts.map((conflict) => (
											<div key={conflict.id} className="flex items-center justify-between gap-2 rounded-md border border-border-subtle px-2 py-1.5">
												<span className="flex-1 truncate text-sm">{conflict.label}</span>
												{/* 二选一按钮组（本地/云端）：选中态 primary，语义等价于 radio，桌面工作台风格。 */}
												<div className="flex items-center gap-1 text-sm">
													<Button
														size="sm"
														variant={(selection.conflictChoices[conflict.id] ?? "local") === "local" ? "default" : "outline"}
														onClick={() => selection.setConflictChoices((prev) => ({ ...prev, [conflict.id]: "local" }))}
													>
														{t("cloudSync.conflict.local")}
													</Button>
													<Button
														size="sm"
														variant={(selection.conflictChoices[conflict.id] ?? "local") === "remote" ? "default" : "outline"}
														onClick={() => selection.setConflictChoices((prev) => ({ ...prev, [conflict.id]: "remote" }))}
													>
														{t("cloudSync.conflict.remote")}
													</Button>
												</div>
											</div>
										))}
									</div>
									<Button size="sm" className="mt-3" onClick={() => void selection.applyConflictResolutions(state.conflicts)} loading={busy}>
										{t("cloudSync.conflict.apply")}
									</Button>
								</SettingBox>
							) : null}

							{state && state.missingExtensions.length > 0 ? (
								<SettingBox>
									<div className="mb-2 text-sm font-medium">{t("cloudSync.extensions.title")}</div>
									<div className="mb-2 text-caption text-text-tertiary">{t("cloudSync.extensions.desc")}</div>
									<div className="space-y-1">
										{state.missingExtensions.map((extension) => (
											<div key={`${extension.scope}:${extension.source}`} className="flex items-center justify-between gap-2 text-sm">
												<span className="truncate">{extension.source} <span className="text-caption text-text-tertiary">({extension.scope})</span></span>
												{extension.error ? <span className="shrink-0 text-warning" title={extension.error}><TriangleAlert size={14} aria-label={extension.error} /></span> : null}
											</div>
										))}
									</div>
									<Button size="sm" className="mt-3" variant="outline" onClick={() => void restoreExtensions()} loading={busy}>
										{t("cloudSync.extensions.retry")}
									</Button>
								</SettingBox>
							) : null}

							<div className="mt-3 flex flex-wrap gap-4 text-caption text-text-tertiary">
								<span>{t("cloudSync.content.versions", { local: state?.localVersion ?? 0, remote: state?.remoteVersion ?? 0 })}</span>
							</div>
						</SettingsSection>
					) : (
						<div className="text-caption text-text-tertiary">{t("cloudSync.content.lockedHint")}</div>
					)}
				</TabsContent>

				<TabsContent value="backup" className="mt-0">
					<SettingsSection title={t("cloudSync.backup.title")} description={t("cloudSync.backup.desc")} boxed={false}>
						<SettingBox>
							<div className="text-sm font-medium">{t("cloudSync.backup.exportTitle")}</div>
							<div className="mt-0.5 text-caption text-text-tertiary">{t("cloudSync.backup.exportDesc")}</div>
							<div className="mt-3">
								{unlocked ? (
									<Button size="sm" onClick={() => void backup.handleExport()} loading={busy}>
										<Download size={14} /> {busy ? t("cloudSync.backup.exporting") : t("cloudSync.backup.exportButton")}
									</Button>
								) : (
									<div className="text-caption text-text-tertiary">{t("cloudSync.backup.exportRequiresUnlock")}</div>
								)}
							</div>
						</SettingBox>

						<SettingBox>
							<div className="text-sm font-medium">{t("cloudSync.backup.importTitle")}</div>
							<div className="mt-0.5 text-caption text-text-tertiary">{t("cloudSync.backup.importDesc")}</div>
							<div className="mt-3 space-y-3">
								<Field label={t("cloudSync.backup.importFile")}>
									<div className="flex gap-2">
										<Input
											value={backup.importFilePath}
											onChange={(event) => backup.setImportFilePath(event.target.value)}
											placeholder="pideck-backup-2026-08-01.pideckbackup"
											className="min-w-0 flex-1"
										/>
										<Button size="sm" variant="outline" onClick={() => void backup.handlePickImportFile()}>
											<FolderOpen size={14} /> {t("cloudSync.backup.importPick")}
										</Button>
									</div>
								</Field>
								<Field label={t("cloudSync.backup.importPassword")}>
									<SecretInput placeholder={t("cloudSync.backup.importPassword")} value={backup.importPassword} onChange={backup.setImportPassword} />
								</Field>
								<Field label={t("cloudSync.backup.importMode")}>
									<Select value={backup.importMode} onValueChange={(value) => backup.setImportMode(value as "merge" | "overwrite" | "restoreMissing")}>
										<SelectTrigger className="w-full max-w-sm"><SelectValue /></SelectTrigger>
										<SelectContent>
											<SelectItem value="merge">{t("cloudSync.backup.importModeMerge")}</SelectItem>
											<SelectItem value="overwrite">{t("cloudSync.backup.importModeOverwrite")}</SelectItem>
											<SelectItem value="restoreMissing">{t("cloudSync.backup.importModeRestoreMissing")}</SelectItem>
										</SelectContent>
									</Select>
								</Field>
								<Button size="sm" onClick={() => void backup.handleImport()} loading={busy} disabled={!backup.importFilePath.trim() || !backup.importPassword}>
									<Upload size={14} /> {busy ? t("cloudSync.backup.importing") : t("cloudSync.backup.importButton")}
								</Button>
							</div>
						</SettingBox>

						{error ? (
							<div className="text-sm text-destructive">{error}</div>
						) : null}
					</SettingsSection>
				</TabsContent>
			</Tabs>
		</div>
	);
}
