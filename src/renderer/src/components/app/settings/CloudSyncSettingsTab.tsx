import { useCallback, useMemo, useState } from "react";
import { Cloud, KeyRound, Lock, Unlock, RefreshCw, ShieldCheck } from "lucide-react";
import { t } from "../../../i18n";
import { useCloudSync } from "../../../hooks/useCloudSync";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingBox, SettingRow } from "./SettingRows";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import type {
	CloudSyncProjectSelectionNode,
	CloudSyncResourceCategory,
	CloudSyncSelectionTree,
} from "../../../../../shared/types";
import { cn } from "../../../lib/utils";

/** 主密码表单：设置 / 解锁 / 换钥共用布局。 */
function PasswordForm(props: {
	title: string;
	description: string;
	submitLabel: string;
	confirm?: boolean;
	oldLabel?: string;
	onSubmit: (oldPassword: string | undefined, password: string) => Promise<unknown>;
}) {
	const [oldPassword, setOldPassword] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const submit = async () => {
		if (props.confirm && password !== confirm) return;
		if (password.length < 8) return;
		setSubmitting(true);
		try {
			await props.onSubmit(props.oldLabel ? oldPassword : undefined, password);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<SettingBox>
			<div className="space-y-3">
				<div className="text-caption text-text-tertiary">{props.description}</div>
				{props.oldLabel ? (
					<Input
						type="password"
						placeholder={props.oldLabel}
						value={oldPassword}
						onChange={(event) => setOldPassword(event.target.value)}
						className="max-w-sm"
					/>
				) : null}
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

function ProviderCard(props: {
	provider: "webdav" | "s3";
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
				<div className="flex gap-2">
					<Select value={(config.authType as string) ?? "basic"} onValueChange={(value) => set("authType", value)}>
						<SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
						<SelectContent>
							<SelectItem value="basic">basic</SelectItem>
							<SelectItem value="digest">digest</SelectItem>
							<SelectItem value="token">token</SelectItem>
						</SelectContent>
					</Select>
					<Input placeholder={t("cloudSync.provider.username")} value={(config.username as string) ?? ""} onChange={(e) => set("username", e.target.value)} />
					<Input type="password" placeholder={t("cloudSync.provider.password")} value={(config.password as string) ?? ""} onChange={(e) => set("password", e.target.value)} />
				</div>
			</>
		)
		: (
			<>
				<div className="flex gap-2">
					<Input placeholder={t("cloudSync.provider.endpoint")} value={(config.endpoint as string) ?? ""} onChange={(e) => set("endpoint", e.target.value)} />
					<Input placeholder={t("cloudSync.provider.region")} value={(config.region as string) ?? ""} onChange={(e) => set("region", e.target.value)} />
					<Input placeholder={t("cloudSync.provider.bucket")} value={(config.bucket as string) ?? ""} onChange={(e) => set("bucket", e.target.value)} />
				</div>
				<div className="flex gap-2">
					<Input placeholder={t("cloudSync.provider.accessKeyId")} value={(config.accessKeyId as string) ?? ""} onChange={(e) => set("accessKeyId", e.target.value)} />
					<Input type="password" placeholder={t("cloudSync.provider.secretAccessKey")} value={(config.secretAccessKey as string) ?? ""} onChange={(e) => set("secretAccessKey", e.target.value)} />
					<Input placeholder={t("cloudSync.provider.prefix")} value={(config.prefix as string) ?? ""} onChange={(e) => set("prefix", e.target.value)} />
				</div>
			</>
		);

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2 text-body font-medium">
					<Cloud size={16} />
					{props.provider === "webdav" ? t("cloudSync.provider.webdavTitle") : t("cloudSync.provider.s3Title")}
				</div>
				<div className="flex items-center gap-2">
					{props.account ? <span className="text-caption text-text-tertiary">{props.account}</span> : null}
					<span className={cn("text-caption", props.status === "connected" ? "text-success" : "text-text-tertiary")}>
						{props.status === "connected" ? t("cloudSync.provider.connected") : props.status === "connecting" ? t("cloudSync.provider.connecting") : t("cloudSync.provider.disconnected")}
					</span>
				</div>
			</div>
			<div className="grid gap-2">{fields}</div>
			<div className="flex items-center gap-2">
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

function ProjectSelectionNode(props: {
	node: CloudSyncProjectSelectionNode;
	onToggleSession: (selectionId: string) => void;
	onToggleResource: (selectionId: string) => void;
	onToggleNodeSessions: (projectId: string, all: boolean) => void;
}) {
	const { node } = props;
	const sessionCount = node.sessions.length;
	const selectedCount = node.sessions.filter((session) => session.selected).length;
	return (
		<div className="space-y-1">
			<div className="flex items-center gap-2">
				<Checkbox
					checked={sessionCount > 0 && selectedCount === sessionCount ? true : selectedCount > 0 ? "indeterminate" : false}
					onCheckedChange={() => props.onToggleNodeSessions(node.projectId, selectedCount < sessionCount)}
				/>
				<span className="flex-1 truncate text-sm font-medium">{node.name}</span>
				<span className="text-caption text-text-tertiary">
					{t("cloudSync.content.sessionCount", { count: sessionCount, selected: selectedCount })}
				</span>
			</div>
			<div className="ml-6 space-y-1">
				{node.sessions.map((session) => (
					<label key={session.selectionId} className="flex cursor-pointer items-center gap-2 py-0.5">
						<Checkbox
							checked={session.selected}
							disabled={session.status === "unavailable"}
							onCheckedChange={() => props.onToggleSession(session.selectionId)}
						/>
						<span className="flex-1 truncate text-sm text-foreground/90">{session.title || session.relativePath}</span>
						{session.status === "unavailable" && session.reason ? (
							<span className="text-caption text-warning" title={session.reason}>⚠</span>
						) : null}
					</label>
				))}
				{node.resources.map((resource) => (
					<label key={resource.selectionId} className="flex cursor-pointer items-center gap-2 py-0.5">
						<Checkbox
							checked={resource.selected}
							disabled={resource.status === "unavailable"}
							onCheckedChange={() => props.onToggleResource(resource.selectionId)}
						/>
						<span className="flex-1 truncate text-sm text-foreground/70">
							[{categoryLabel(resource.category)}] {resource.relativePath}
						</span>
					</label>
				))}
			</div>
		</div>
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
		changePassword,
		configureProvider,
		disconnectProvider,
		connect,
		scan,
		updateSelection,
		syncNow,
		setAutoSync,
		setStrategy,
	} = useCloudSync();

	const securityState = state?.securityState ?? "NO_KEY";
	const unlocked = securityState === "UNLOCKED";

	const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
	const [selectedResourceIds, setSelectedResourceIds] = useState<Set<string>>(new Set());
	const [autoSyncInterval, setAutoSyncInterval] = useState(5);

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

	const providers = state?.providers;
	const webdavSnapshot = providers?.webdav;
	const s3Snapshot = providers?.s3;

	return (
		<div className="space-y-2">
			<SettingsSection title={t("cloudSync.security.title")} description={t("cloudSync.security.desc")}>
				{securityState === "NO_KEY" ? (
					<PasswordForm
						title=""
						description={t("cloudSync.security.noKeyDesc")}
						submitLabel={t("cloudSync.security.setup")}
						confirm
						onSubmit={(_old, password) => setupMasterKey(password)}
					/>
				) : securityState === "LOCKED" ? (
					<PasswordForm
						title=""
						description={t("cloudSync.security.lockedDesc")}
						submitLabel={t("cloudSync.security.unlock")}
						onSubmit={(_old, password) => unlock(password)}
					/>
				) : (
					<SettingBox>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="flex items-center gap-2 text-body">
								<ShieldCheck size={16} className="text-success" />
								{t("cloudSync.security.unlocked")}
							</div>
							<div className="flex items-center gap-2">
								<Button size="sm" variant="outline" onClick={() => void changePassword("", "")}> {t("cloudSync.security.changePassword")}</Button>
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
								configured={Boolean(webdavSnapshot?.configured)}
								status={webdavSnapshot?.status ?? "disconnected"}
								account={webdavSnapshot?.account?.name}
								onConnect={(config) => void configureProvider(config as never)}
								onDisconnect={() => void disconnectProvider("webdav")}
							/>
							<ProviderCard
								provider="s3"
								configured={Boolean(s3Snapshot?.configured)}
								status={s3Snapshot?.status ?? "disconnected"}
								account={s3Snapshot?.account?.name}
								onConnect={(config) => void configureProvider(config as never)}
								onDisconnect={() => void disconnectProvider("s3")}
							/>
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
								<Button size="sm" onClick={() => void syncSelection()} disabled={!selectionTree} loading={busy}>
									{t("cloudSync.content.saveSelection")}
								</Button>
								<Button size="sm" variant="default" onClick={() => void syncNow(false)} loading={busy}>
									<KeyRound size={14} /> {t("cloudSync.content.syncNow")}
								</Button>
							</div>
						</SettingBox>

						{selectionTree && selectionTree.projects.length > 0 ? (
							<div className="mt-3 space-y-3">
								{selectionTree.projects.map((node) => (
									<ProjectSelectionNode
										key={node.projectId}
										node={node}
										onToggleSession={toggleSession}
										onToggleResource={toggleResource}
										onToggleNodeSessions={toggleNodeSessions}
									/>
								))}
							</div>
						) : (
							<div className="mt-3 text-caption text-text-tertiary">{t("cloudSync.content.empty")}</div>
						)}

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
