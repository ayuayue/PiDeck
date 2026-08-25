import { useCallback, useState } from "react";
import {
	ChevronDown,
	ChevronRight,
	Cloud,
	FileText,
	Folder,
	FolderGit2,
	Globe,
	KeyRound,
	Lock,
	Puzzle,
	RefreshCw,
	Settings2,
	ShieldCheck,
} from "lucide-react";
import { t } from "../../../i18n";
import { useCloudSync } from "../../../hooks/useCloudSync";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingBox } from "./SettingRows";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../ui-shadcn/collapsible";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import type {
	CloudSyncProjectSelectionNode,
	CloudSyncResourceCategory,
	CloudSyncSelectionTree,
} from "../../../../../shared/types";
import { cn } from "../../../lib/utils";

const GLOBAL_SYNC_PROJECT_ID = "__global__";

/** 主密码表单：设置 / 解锁共用布局。 */
function PasswordForm(props: {
	description: string;
	submitLabel: string;
	confirm?: boolean;
	onSubmit: (password: string) => Promise<unknown>;
}) {
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const submit = async () => {
		if (props.confirm && password !== confirm) return;
		if (password.length < 8) return;
		setSubmitting(true);
		try {
			await props.onSubmit(password);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<SettingBox>
			<div className="space-y-3">
				<div className="text-caption text-text-tertiary">{props.description}</div>
				<Input
					type="password"
					placeholder={t("cloudSync.security.password")}
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					className="max-w-sm"
				/>
				{props.confirm ? (
					<Input
						type="password"
						placeholder={t("cloudSync.security.confirmPassword")}
						value={confirm}
						onChange={(event) => setConfirm(event.target.value)}
						className="max-w-sm"
					/>
				) : null}
				{props.confirm && password !== confirm && password.length > 0 ? (
					<div className="text-xs text-destructive">{t("cloudSync.security.passwordMismatch")}</div>
				) : null}
				<div className="flex items-center gap-2">
					<Button size="sm" onClick={() => void submit()} loading={submitting} disabled={password.length < 8 || (props.confirm ? password !== confirm : false)}>
						{props.submitLabel}
					</Button>
				</div>
			</div>
		</SettingBox>
	);
}

/** Provider 状态点：连接态用语义色，未连接灰色。 */
function StatusDot(props: { status: string }) {
	return (
		<span
			aria-hidden
			className={cn(
				"inline-block size-2 rounded-full",
				props.status === "connected" ? "bg-success" : props.status === "connecting" ? "bg-warning" : "bg-text-tertiary/50",
			)}
		/>
	);
}

function ProviderCard(props: {
	provider: "webdav" | "s3";
	icon: React.ReactNode;
	title: string;
	configured: boolean;
	status: string;
	account?: string;
	onConnect: (config: Record<string, unknown>) => void;
	onDisconnect: () => void;
}) {
	const [config, setConfig] = useState<Record<string, unknown>>({});

	const set = (key: string, value: string | boolean) => {
		setConfig((prev) => ({ ...prev, [key]: value }));
	};

	const fields = props.provider === "webdav"
		? (
			<>
				<Input placeholder={t("cloudSync.provider.endpoint")} value={(config.endpoint as string) ?? ""} onChange={(e) => set("endpoint", e.target.value)} />
				<div className="flex flex-wrap gap-2">
					<Select value={(config.authType as string) ?? "basic"} onValueChange={(value) => set("authType", value)}>
						<SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
						<SelectContent>
							<SelectItem value="basic">basic</SelectItem>
							<SelectItem value="digest">digest</SelectItem>
							<SelectItem value="token">token</SelectItem>
						</SelectContent>
					</Select>
					<Input placeholder={t("cloudSync.provider.username")} value={(config.username as string) ?? ""} onChange={(e) => set("username", e.target.value)} className="flex-1" />
					<Input type="password" placeholder={t("cloudSync.provider.password")} value={(config.password as string) ?? ""} onChange={(e) => set("password", e.target.value)} className="flex-1" />
				</div>
			</>
		)
		: (
			<>
				<div className="flex flex-wrap gap-2">
					<Input placeholder={t("cloudSync.provider.endpoint")} value={(config.endpoint as string) ?? ""} onChange={(e) => set("endpoint", e.target.value)} className="flex-[2]" />
					<Input placeholder={t("cloudSync.provider.region")} value={(config.region as string) ?? ""} onChange={(e) => set("region", e.target.value)} className="flex-1" />
					<Input placeholder={t("cloudSync.provider.bucket")} value={(config.bucket as string) ?? ""} onChange={(e) => set("bucket", e.target.value)} className="flex-1" />
				</div>
				<div className="flex flex-wrap gap-2">
					<Input placeholder={t("cloudSync.provider.accessKeyId")} value={(config.accessKeyId as string) ?? ""} onChange={(e) => set("accessKeyId", e.target.value)} className="flex-1" />
					<Input type="password" placeholder={t("cloudSync.provider.secretAccessKey")} value={(config.secretAccessKey as string) ?? ""} onChange={(e) => set("secretAccessKey", e.target.value)} className="flex-1" />
					<Input placeholder={t("cloudSync.provider.prefix")} value={(config.prefix as string) ?? ""} onChange={(e) => set("prefix", e.target.value)} className="flex-1" />
				</div>
			</>
		);

	return (
		<div className="rounded-lg border border-border-subtle bg-background/40 p-3">
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2 text-body font-medium">
					{props.icon}
					{props.title}
				</div>
				<div className="flex items-center gap-2">
					{props.account ? <span className="max-w-40 truncate text-caption text-text-tertiary">{props.account}</span> : null}
					<span className="flex items-center gap-1.5 text-caption text-text-tertiary">
						<StatusDot status={props.status} />
						{props.status === "connected"
							? t("cloudSync.provider.connected")
							: props.status === "connecting"
								? t("cloudSync.provider.connecting")
								: t("cloudSync.provider.disconnected")}
					</span>
				</div>
			</div>
			<div className="mt-3 grid gap-2">{fields}</div>
			<div className="mt-3 flex items-center gap-2">
				<Button size="sm" onClick={() => props.onConnect({ ...config, provider: props.provider })}>
					{t("cloudSync.provider.saveAndConnect")}
				</Button>
				{props.configured ? (
					<Button size="sm" variant="outline" onClick={props.onDisconnect}>
						{t("cloudSync.provider.remove")}
					</Button>
				) : null}
			</div>
		</div>
	);
}

function SessionRow(props: {
	title: string;
	relativePath: string;
	selected: boolean;
	disabled: boolean;
	reason?: string;
	onToggle: () => void;
}) {
	return (
		<label className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/50">
			<Checkbox checked={props.selected} disabled={props.disabled} onCheckedChange={props.onToggle} />
			<FileText size={14} className="shrink-0 text-text-tertiary" />
			<span className="flex-1 truncate text-sm text-foreground/90">{props.title || props.relativePath}</span>
			{props.disabled && props.reason ? (
				<span className="shrink-0 text-caption text-warning" title={props.reason}>⚠</span>
			) : null}
		</label>
	);
}

function ResourceRow(props: {
	label: string;
	relativePath: string;
	selected: boolean;
	disabled: boolean;
	reason?: string;
	onToggle: () => void;
}) {
	return (
		<label className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/50">
			<Checkbox checked={props.selected} disabled={props.disabled} onCheckedChange={props.onToggle} />
			<Puzzle size={14} className="shrink-0 text-text-tertiary" />
			<span className="min-w-0 flex-1 truncate text-sm text-foreground/70">
				<span className="rounded bg-accent/70 px-1 py-px text-caption">{props.label}</span>{" "}
				{props.relativePath}
			</span>
			{props.disabled && props.reason ? (
				<span className="shrink-0 text-caption text-warning" title={props.reason}>⚠</span>
			) : null}
		</label>
	);
}

function categoryLabel(category: CloudSyncResourceCategory): string {
	switch (category) {
		case "settings": return "settings";
		case "prompts": return "prompts";
		case "skills": return "skills";
		case "extensions": return "extensions";
	}
}

/** 项目选择节点：可折叠，头部含全选三态勾选 + 计数，默认收起。 */
function ProjectSelectionNode(props: {
	node: CloudSyncProjectSelectionNode;
	expanded: boolean;
	onToggleExpanded: () => void;
	onToggleSession: (selectionId: string) => void;
	onToggleResource: (selectionId: string) => void;
	onToggleNodeSessions: (projectId: string, all: boolean) => void;
}) {
	const { node } = props;
	const sessionCount = node.sessions.length;
	const selectedCount = node.sessions.filter((session) => session.selected).length;
	const resourceCount = node.resources.length;
	const isGlobal = node.projectId === GLOBAL_SYNC_PROJECT_ID;

	return (
		<Collapsible open={props.expanded} onOpenChange={props.onToggleExpanded} className="rounded-lg border border-border-subtle bg-background/40">
			<CollapsibleTrigger asChild>
				<div className="flex w-full cursor-pointer items-center gap-2 px-3 py-2" role="button" tabIndex={0}>
					{props.expanded ? <ChevronDown size={15} className="shrink-0 text-text-tertiary" /> : <ChevronRight size={15} className="shrink-0 text-text-tertiary" />}
					{isGlobal ? <Globe size={15} className="shrink-0 text-primary" /> : <Folder size={15} className="shrink-0 text-text-tertiary" />}
					<Checkbox
						checked={sessionCount > 0 && selectedCount === sessionCount ? true : selectedCount > 0 ? "indeterminate" : false}
						onCheckedChange={() => props.onToggleNodeSessions(node.projectId, selectedCount < sessionCount)}
						onClick={(event) => event.stopPropagation()}
					/>
					<span className="min-w-0 flex-1 truncate text-sm font-medium">{node.name}</span>
					{node.missing ? (
						<span className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-caption text-warning">{t("cloudSync.content.missingProject")}</span>
					) : null}
					<span className="shrink-0 text-caption text-text-tertiary">
						{sessionCount > 0 ? t("cloudSync.content.sessionCount", { count: sessionCount, selected: selectedCount }) : null}
						{resourceCount > 0 ? (sessionCount > 0 ? " · " : "") + t("cloudSync.content.resourceCount", { count: resourceCount }) : null}
					</span>
				</div>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="space-y-1 border-t border-border-subtle px-2 py-2">
					{node.sessions.length > 0 ? (
						<div className="space-y-0.5">
							<div className="px-2 text-caption font-medium text-text-tertiary">{t("cloudSync.content.sessions")}</div>
							{node.sessions.map((session) => (
								<SessionRow
									key={session.selectionId}
									title={session.title}
									relativePath={session.relativePath}
									selected={session.selected}
									disabled={session.status === "unavailable"}
									reason={session.reason}
									onToggle={() => props.onToggleSession(session.selectionId)}
								/>
							))}
						</div>
					) : null}
					{node.resources.length > 0 ? (
						<div className="space-y-0.5 pt-1">
							<div className="px-2 text-caption font-medium text-text-tertiary">{t("cloudSync.content.resources")}</div>
							{node.resources.map((resource) => (
								<ResourceRow
									key={resource.selectionId}
									label={categoryLabel(resource.category)}
									relativePath={resource.relativePath}
									selected={resource.selected}
									disabled={resource.status === "unavailable"}
									reason={resource.reason}
									onToggle={() => props.onToggleResource(resource.selectionId)}
								/>
							))}
						</div>
					) : null}
					{sessionCount === 0 && resourceCount === 0 ? (
						<div className="px-2 py-1 text-caption text-text-tertiary">{t("cloudSync.content.nodeEmpty")}</div>
					) : null}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

/** 云同步设置页：主密码 → Provider → 选择树 → 同步。 */
export function CloudSyncSettingsTab() {
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
		updateSelection,
		syncNow,
		resolveConflicts,
		restoreExtensions,
		githubDeviceStart,
		githubDevicePoll,
		setAutoSync,
		setStrategy,
	} = useCloudSync();

	const securityState = state?.securityState ?? "NO_KEY";
	const unlocked = securityState === "UNLOCKED";

	const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
	const [selectedResourceIds, setSelectedResourceIds] = useState<Set<string>>(new Set());
	const [autoSyncInterval, setAutoSyncInterval] = useState(5);
	/** 冲突选择（id → local/remote），默认本地优先。 */
	const [conflictChoices, setConflictChoices] = useState<Record<string, "local" | "remote">>({});
	/** 折叠的项目节点；全局默认展开，其余默认收起。 */
	const [expandedProjectIds, setExpandedProjectIds] = useState<ReadonlySet<string>>(new Set([GLOBAL_SYNC_PROJECT_ID]));

	const selectionTree = tree as CloudSyncSelectionTree | null;

	const syncSelection = useCallback(async () => {
		await updateSelection({
			selectedSessionIds: [...selectedSessionIds],
			selectedResourceIds: [...selectedResourceIds],
		});
	}, [updateSelection, selectedSessionIds, selectedResourceIds]);

	const toggleSession = useCallback((selectionId: string) => {
		setSelectedSessionIds((prev) => {
			const next = new Set(prev);
			if (next.has(selectionId)) next.delete(selectionId);
			else next.add(selectionId);
			return next;
		});
	}, []);

	const toggleResource = useCallback((selectionId: string) => {
		setSelectedResourceIds((prev) => {
			const next = new Set(prev);
			if (next.has(selectionId)) next.delete(selectionId);
			else next.add(selectionId);
			return next;
		});
	}, []);

	const toggleNodeSessions = useCallback((projectId: string, all: boolean) => {
		const node = selectionTree?.projects.find((candidate) => candidate.projectId === projectId);
		if (!node) return;
		setSelectedSessionIds((prev) => {
			const next = new Set(prev);
			for (const session of node.sessions) {
				if (all) next.add(session.selectionId);
				else next.delete(session.selectionId);
			}
			return next;
		});
	}, [selectionTree]);

	const toggleExpanded = useCallback((projectId: string) => {
		setExpandedProjectIds((prev) => {
			const next = new Set(prev);
			if (next.has(projectId)) next.delete(projectId);
			else next.add(projectId);
			return next;
		});
	}, []);

	const handleScan = useCallback(async () => {
		const next = await scan();
		if (!next) return;
		setSelectedSessionIds(new Set(next.projects.flatMap((project) => project.sessions).filter((session) => session.selected).map((session) => session.selectionId)));
		setSelectedResourceIds(new Set(next.projects.flatMap((project) => project.resources).filter((resource) => resource.selected).map((resource) => resource.selectionId)));
	}, [scan]);

	const handleToggleAll = useCallback((all: boolean) => {
		if (!selectionTree) return;
		setSelectedSessionIds(new Set(all ? selectionTree.projects.flatMap((project) => project.sessions).map((session) => session.selectionId) : []));
		setSelectedResourceIds(new Set(all ? selectionTree.projects.flatMap((project) => project.resources).map((resource) => resource.selectionId) : []));
	}, [selectionTree]);

	const applyConflictResolutions = useCallback(async () => {
		const resolutions = (state?.conflicts ?? []).map((conflict) => ({
			id: conflict.id,
			choice: conflictChoices[conflict.id] ?? "local",
		}));
		if (resolutions.length === 0) return;
		await resolveConflicts(resolutions);
	}, [state?.conflicts, conflictChoices, resolveConflicts]);

	const providers = state?.providers;
	const webdavSnapshot = providers?.webdav;
	const s3Snapshot = providers?.s3;
	const githubSnapshot = providers?.github;

	// GitHub Device Flow：token 只在主进程换取并配置，渲染层只展示验证 URL/code。
	const [githubClientId, setGithubClientId] = useState("");
	const [githubFlow, setGithubFlow] = useState<{ userCode: string; verificationUrl: string; interval: number } | null>(null);
	const startGithubConnect = useCallback(async () => {
		const flow = await githubDeviceStart(githubClientId.trim());
		if (!flow) return;
		setGithubFlow({ userCode: flow.userCode, verificationUrl: flow.verificationUrl, interval: Math.max(5, flow.interval) });
		const timer = window.setInterval(async () => {
			const result = await githubDevicePoll();
			if (!result) return;
			if (result.status !== "pending") {
				window.clearInterval(timer);
				setGithubFlow(null);
			}
		}, 5000);
	}, [githubDeviceStart, githubDevicePoll, githubClientId]);

	return (
		<div className="space-y-2">
			<SettingsSection title={t("cloudSync.security.title")} description={t("cloudSync.security.desc")}>
				{securityState === "NO_KEY" ? (
					<PasswordForm
						description={t("cloudSync.security.noKeyDesc")}
						submitLabel={t("cloudSync.security.setup")}
						confirm
						onSubmit={(password) => setupMasterKey(password)}
					/>
				) : securityState === "LOCKED" ? (
					<PasswordForm
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
					<SettingsSection title={t("cloudSync.provider.title")} description={t("cloudSync.provider.desc")} divided>
						<div className="grid gap-3">
							<ProviderCard
								provider="webdav"
								icon={<Cloud size={16} className="text-primary" />}
								title={t("cloudSync.provider.webdavTitle")}
								configured={Boolean(webdavSnapshot?.configured)}
								status={webdavSnapshot?.status ?? "disconnected"}
								account={webdavSnapshot?.account?.name}
								onConnect={(config) => void configureProvider(config as never)}
								onDisconnect={() => void disconnectProvider("webdav")}
							/>
							<ProviderCard
								provider="s3"
								icon={<Settings2 size={16} className="text-primary" />}
								title={t("cloudSync.provider.s3Title")}
								configured={Boolean(s3Snapshot?.configured)}
								status={s3Snapshot?.status ?? "disconnected"}
								account={s3Snapshot?.account?.name}
								onConnect={(config) => void configureProvider(config as never)}
								onDisconnect={() => void disconnectProvider("s3")}
							/>
							<div className="rounded-lg border border-border-subtle bg-background/40 p-3">
								<div className="flex items-center justify-between gap-2">
									<div className="flex items-center gap-2 text-body font-medium">
										<FolderGit2 size={16} className="text-primary" />
										{t("cloudSync.provider.githubTitle")}
									</div>
									<span className="flex items-center gap-1.5 text-caption text-text-tertiary">
										<StatusDot status={githubSnapshot?.status ?? "disconnected"} />
										{githubSnapshot?.status === "connected" ? t("cloudSync.provider.connected") : t("cloudSync.provider.disconnected")}
									</span>
								</div>
								<div className="mt-3 flex flex-wrap items-center gap-2">
									<Input placeholder={t("cloudSync.provider.githubClientId")} value={githubClientId} onChange={(event) => setGithubClientId(event.target.value)} className="max-w-64" />
									<Button size="sm" onClick={() => void startGithubConnect()} disabled={!githubClientId.trim()}>
										{t("cloudSync.provider.githubConnect")}
									</Button>
									{githubSnapshot?.configured ? (
										<Button size="sm" variant="outline" onClick={() => void disconnectProvider("github")}>
											{t("cloudSync.provider.remove")}
										</Button>
									) : null}
								</div>
								{githubFlow ? (
									<div className="mt-3 space-y-1 rounded-md bg-accent/40 px-3 py-2 text-sm">
										<div className="break-all">{t("cloudSync.provider.githubOpenUrl")} <a className="text-primary underline" href={githubFlow.verificationUrl} target="_blank" rel="noreferrer">{githubFlow.verificationUrl}</a></div>
										<div>{t("cloudSync.provider.githubUserCode")} <code className="rounded bg-accent px-1.5 py-0.5 font-mono">{githubFlow.userCode}</code></div>
										<div className="text-caption text-text-tertiary">{t("cloudSync.provider.githubWaiting")}</div>
									</div>
								) : null}
							</div>
						</div>
					</SettingsSection>

					<SettingsSection title={t("cloudSync.content.title")} description={t("cloudSync.content.desc")} divided>
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
										onCheckedChange={(checked) => void setAutoSync(Boolean(checked), autoSyncInterval)}
									/>
									{t("cloudSync.content.autoSync")}
								</label>
							</div>
							<div className="mt-3 flex flex-wrap items-center gap-2">
								<Button size="sm" onClick={() => void handleScan()} loading={busy}>
									<RefreshCw size={14} /> {t("cloudSync.content.scan")}
								</Button>
								<Button size="sm" variant="outline" onClick={() => void handleToggleAll(true)}>{t("cloudSync.content.selectAll")}</Button>
								<Button size="sm" variant="outline" onClick={() => void handleToggleAll(false)}>{t("cloudSync.content.selectNone")}</Button>
								<Button size="sm" variant="outline" onClick={() => void syncSelection()} disabled={!selectionTree} loading={busy}>
									{t("cloudSync.content.saveSelection")}
								</Button>
								<Button size="sm" variant="default" onClick={() => void syncNow(false)} loading={busy}>
									<KeyRound size={14} /> {t("cloudSync.content.syncNow")}
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

						{selectionTree && selectionTree.projects.length > 0 ? (
							<div className="mt-3 max-h-96 space-y-2 overflow-y-auto rounded-lg border border-border-subtle bg-background/30 p-2">
								{selectionTree.projects.map((node) => (
									<ProjectSelectionNode
										key={node.projectId}
										node={node}
										expanded={expandedProjectIds.has(node.projectId)}
										onToggleExpanded={() => toggleExpanded(node.projectId)}
										onToggleSession={toggleSession}
										onToggleResource={toggleResource}
										onToggleNodeSessions={toggleNodeSessions}
									/>
								))}
							</div>
						) : (
							<div className="mt-3 text-caption text-text-tertiary">{t("cloudSync.content.empty")}</div>
						)}

						{state && state.conflicts.length > 0 ? (
							<SettingBox>
								<div className="mb-2 text-sm font-medium">{t("cloudSync.conflict.title")}</div>
								<div className="mb-2 text-caption text-text-tertiary">{t("cloudSync.conflict.desc")}</div>
								<div className="space-y-2">
									{state.conflicts.map((conflict) => (
										<div key={conflict.id} className="flex items-center justify-between gap-2 rounded-md border border-border-subtle px-2 py-1.5">
											<span className="flex-1 truncate text-sm">{conflict.label}</span>
											<div className="flex items-center gap-3 text-sm">
												<label className="flex cursor-pointer items-center gap-1">
													<input
														type="radio"
														name={`conflict-${conflict.id}`}
														checked={(conflictChoices[conflict.id] ?? "local") === "local"}
														onChange={() => setConflictChoices((prev) => ({ ...prev, [conflict.id]: "local" }))}
													/>
													{t("cloudSync.conflict.local")}
												</label>
												<label className="flex cursor-pointer items-center gap-1">
													<input
														type="radio"
														name={`conflict-${conflict.id}`}
														checked={(conflictChoices[conflict.id] ?? "local") === "remote"}
														onChange={() => setConflictChoices((prev) => ({ ...prev, [conflict.id]: "remote" }))}
													/>
													{t("cloudSync.conflict.remote")}
												</label>
											</div>
										</div>
									))}
								</div>
								<Button size="sm" className="mt-3" onClick={() => void applyConflictResolutions()} loading={busy}>
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
											{extension.error ? <span className="shrink-0 text-caption text-warning" title={extension.error}>⚠</span> : null}
										</div>
									))}
								</div>
								<Button size="sm" className="mt-3" variant="outline" onClick={() => void restoreExtensions()} loading={busy}>
									{t("cloudSync.extensions.retry")}
								</Button>
							</SettingBox>
						) : null}

						{state?.lastError ? (
							<div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
								{state.lastError}
							</div>
						) : null}
						{error ? (
							<div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
								{error}
							</div>
						) : null}
						<div className="mt-3 flex flex-wrap gap-4 text-caption text-text-tertiary">
							<span>{t("cloudSync.content.versions", { local: state?.localVersion ?? 0, remote: state?.remoteVersion ?? 0 })}</span>
							<span>{t("cloudSync.content.state", { state: state?.syncState ?? "IDLE" })}</span>
						</div>
					</SettingsSection>
				</>
			) : null}
		</div>
	);
}
