import { useState } from "react";
import { Cloud, Folder, Globe } from "lucide-react";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { Field, GithubMarkIcon, ProviderActionBar, ProviderCardShell, SecretInput } from "./CloudSyncProviderShell";

/**
 * 云同步服务卡组件族：WebDAV/S3 通用卡片 + GitHub（Device Flow）/本地文件夹/OneDrive/Google 专用卡片。
 * 折叠头部、状态行、操作按钮组等共享外壳见 CloudSyncProviderShell。
 */

/** WebDAV / S3 通用服务卡：展开后为配置表单（保存并连接/取消/重连/移除）。 */
export function ProviderCard(props: {
	provider: "webdav" | "s3";
	icon: React.ReactNode;
	title: string;
	description?: string;
	configured: boolean;
	status: string;
	account?: string;
	onConnect: (config: Record<string, unknown>) => void;
	onDisconnect: () => void;
	onReconnect?: () => void;
}) {
	const [config, setConfig] = useState<Record<string, unknown>>({ authType: "basic", allowInsecure: false });
	const [webdavPresetHint, setWebdavPresetHint] = useState<"nutstore" | "infinicloud" | null>(null);

	const set = (key: string, value: string | boolean) => {
		setConfig((prev) => ({ ...prev, [key]: value }));
	};

	const applyWebdavPreset = (preset: "nutstore" | "infinicloud") => {
		if (preset === "nutstore") {
			set("endpoint", "https://dav.jianguoyun.com/dav/");
			set("authType", "basic");
		}
		// InfiniCloud 地址是每账号子域名，只给引导，让用户粘贴。
		setWebdavPresetHint(preset);
	};

	const fields = props.provider === "webdav"
		? (
			<>
				<Field label={t("cloudSync.provider.field.endpoint")}>
					<Input placeholder="https://dav.example.com/remote.php/webdav/" value={(config.endpoint as string) ?? ""} onChange={(e) => set("endpoint", e.target.value)} />
				</Field>
				<div className="flex flex-wrap items-center gap-2 pt-1 text-caption text-text-tertiary">
					<span>{t("cloudSync.provider.webdavPresets")}</span>
					<Button size="sm" variant="outline" onClick={() => applyWebdavPreset("nutstore")}>{t("cloudSync.provider.webdavPresetNutstore")}</Button>
					<Button size="sm" variant="outline" onClick={() => applyWebdavPreset("infinicloud")}>{t("cloudSync.provider.webdavPresetInfiniCloud")}</Button>
				</div>
				{webdavPresetHint === "nutstore" ? (
					<p className="text-caption text-text-tertiary">{t("cloudSync.provider.webdavNutstoreHint")}</p>
				) : webdavPresetHint === "infinicloud" ? (
					<p className="text-caption text-text-tertiary">{t("cloudSync.provider.webdavInfiniCloudHint")}</p>
				) : null}
				<div className="grid gap-3 sm:grid-cols-3">
					<Field label={t("cloudSync.provider.field.authType")}>
						<Select value={(config.authType as string) ?? "basic"} onValueChange={(value) => set("authType", value)}>
							<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
							<SelectContent>
								<SelectItem value="basic">basic</SelectItem>
								<SelectItem value="digest">digest</SelectItem>
								<SelectItem value="token">token</SelectItem>
							</SelectContent>
						</Select>
					</Field>
					<Field label={t("cloudSync.provider.field.username")}>
						<Input autoComplete="username" placeholder={t("cloudSync.provider.field.username")} value={(config.username as string) ?? ""} onChange={(e) => set("username", e.target.value)} />
					</Field>
					<Field label={t("cloudSync.provider.field.password")}>
						<SecretInput placeholder={t("cloudSync.provider.field.password")} value={(config.password as string) ?? ""} onChange={(value) => set("password", value)} />
					</Field>
				</div>
				<label className="flex cursor-pointer items-center gap-2 pt-1 text-sm">
					<Checkbox
						checked={config.allowInsecure === true}
						onCheckedChange={(checked) => set("allowInsecure", Boolean(checked))}
					/>
					{t("cloudSync.provider.allowInsecure")}
				</label>
			</>
		)
		: (
			<>
				<Field label={t("cloudSync.provider.field.endpoint")}>
					<Input placeholder="https://s3.example.com" value={(config.endpoint as string) ?? ""} onChange={(e) => set("endpoint", e.target.value)} />
				</Field>
				<div className="grid gap-3 sm:grid-cols-3">
					<Field label={t("cloudSync.provider.field.region")}>
						<Input placeholder="us-east-1" value={(config.region as string) ?? ""} onChange={(e) => set("region", e.target.value)} />
					</Field>
					<Field label={t("cloudSync.provider.field.bucket")}>
						<Input placeholder="pideck-backups" value={(config.bucket as string) ?? ""} onChange={(e) => set("bucket", e.target.value)} />
					</Field>
					<Field label={t("cloudSync.provider.field.prefix")}>
						<Input placeholder="backups/pideck" value={(config.prefix as string) ?? ""} onChange={(e) => set("prefix", e.target.value)} />
					</Field>
				</div>
				<div className="grid gap-3 sm:grid-cols-2">
					<Field label={t("cloudSync.provider.field.accessKeyId")}>
						<Input autoComplete="off" placeholder={t("cloudSync.provider.field.accessKeyId")} value={(config.accessKeyId as string) ?? ""} onChange={(e) => set("accessKeyId", e.target.value)} />
					</Field>
					<Field label={t("cloudSync.provider.field.secretAccessKey")}>
						<SecretInput placeholder={t("cloudSync.provider.field.secretAccessKey")} value={(config.secretAccessKey as string) ?? ""} onChange={(value) => set("secretAccessKey", value)} />
					</Field>
				</div>
				<label className="flex cursor-pointer items-center gap-2 pt-1 text-sm">
					<Checkbox
						checked={config.allowInsecure === true}
						onCheckedChange={(checked) => set("allowInsecure", Boolean(checked))}
					/>
					{t("cloudSync.provider.allowInsecure")}
				</label>
			</>
		);

	return (
		<ProviderCardShell
			icon={props.icon}
			title={props.title}
			description={props.description}
			account={props.account}
			status={props.status}
			configured={props.configured}
		>
			{(close) => (
				<>
					{fields}
					<ProviderActionBar
						primaryLabel={t("cloudSync.provider.saveAndConnect")}
						onPrimary={() => props.onConnect({ ...config, provider: props.provider })}
						onCancel={close}
						configured={props.configured}
						status={props.status}
						onReconnect={props.onReconnect}
						onDisconnect={props.onDisconnect}
					/>
				</>
			)}
		</ProviderCardShell>
	);
}

/** GitHub 服务卡：正文为 Device Flow 连接区（内置凭据时隐藏 Client ID 输入，直接浏览器授权）。 */
export function GithubProviderCard(props: {
	status: string;
	configured: boolean;
	/** 已内置应用凭据（构建期注入）：隐藏 Client ID 输入，直接浏览器连接（对齐 Netcatty）。 */
	builtin?: boolean;
	clientId: string;
	onClientIdChange: (value: string) => void;
	onConnect: () => void;
	onDisconnect: () => void;
	onReconnect?: () => void;
	flow: { userCode: string; verificationUrl: string; interval: number } | null;
	/** 设备流轮询失败的可展示错误（IPC 失败或主进程返回 error 时给出）。 */
	flowError?: string | null;
}) {
	return (
		<ProviderCardShell
			icon={<GithubMarkIcon className="size-5" />}
			title={t("cloudSync.provider.githubTitle")}
			description={t("cloudSync.provider.githubDesc")}
			status={props.status}
			configured={props.configured}
		>
			{() => (
				<>
					{!props.builtin ? (
						<Field label={t("cloudSync.provider.field.clientId")}>
							<div className="space-y-1">
								<Input placeholder="Iv1xxxxxxxxxxxxxxxxxx" value={props.clientId} onChange={(event) => props.onClientIdChange(event.target.value)} />
								<p className="text-caption text-text-tertiary">{t("cloudSync.provider.field.clientIdHint")}</p>
							</div>
						</Field>
					) : null}
					<ProviderActionBar
						primaryLabel={t("cloudSync.provider.githubConnect")}
						onPrimary={props.onConnect}
						primaryDisabled={!props.builtin && !props.clientId.trim()}
						configured={props.configured}
						status={props.status}
						onReconnect={props.onReconnect}
						onDisconnect={props.onDisconnect}
						removeVariant="outline"
					/>
					{props.flow ? (
						<div className="space-y-1 rounded-md bg-accent/40 px-3 py-2 text-sm">
							<div className="break-all">{t("cloudSync.provider.githubOpenUrl")} <a className="text-primary underline" href={props.flow.verificationUrl} target="_blank" rel="noreferrer">{props.flow.verificationUrl}</a></div>
							<div>{t("cloudSync.provider.githubUserCode")} <code className="rounded bg-accent px-1.5 py-0.5 font-mono">{props.flow.userCode}</code></div>
							<div className="text-caption text-text-tertiary">{t("cloudSync.provider.githubWaiting")}</div>
						</div>
					) : null}
					{props.flowError ? (
						<div className="text-sm text-destructive">{props.flowError}</div>
					) : null}
				</>
			)}
		</ProviderCardShell>
	);
}

/** 本地同步文件夹服务卡：选一个已被网盘客户端同步的本地文件夹，上传交给网盘客户端。 */
export function LocalFolderProviderCard(props: {
	status: string;
	configured: boolean;
	onConnect: (folderPath: string) => void;
	onDisconnect: () => void;
	onReconnect?: () => void;
}) {
	const [folderPath, setFolderPath] = useState("");

	const browse = async () => {
		const picked = await desktopApi.dialog.pickFiles({ title: t("cloudSync.provider.localBrowse"), includeDirectories: true });
		if (picked.length > 0) setFolderPath(picked[0]);
	};

	return (
		<ProviderCardShell
			icon={<Folder size={16} />}
			title={t("cloudSync.provider.localTitle")}
			description={t("cloudSync.provider.localDesc")}
			status={props.status}
			configured={props.configured}
		>
			{(close) => (
				<>
					<Field label={t("cloudSync.provider.localFieldFolder")}>
						<div className="flex gap-2">
							<Input
								placeholder="C:\\Users\\you\\OneDrive\\PiDeck"
								value={folderPath}
								onChange={(event) => setFolderPath(event.target.value)}
								className="min-w-0 flex-1"
							/>
							<Button size="sm" variant="outline" onClick={() => void browse()}>
								<Folder size={14} /> {t("cloudSync.provider.localBrowse")}
							</Button>
						</div>
						<p className="text-caption text-text-tertiary">{t("cloudSync.provider.kind.folderHint")}</p>
					</Field>
					<ProviderActionBar
						primaryLabel={t("cloudSync.provider.saveAndConnect")}
						onPrimary={() => props.onConnect(folderPath.trim())}
						primaryDisabled={!folderPath.trim()}
						onCancel={close}
						configured={props.configured}
						status={props.status}
						onReconnect={props.onReconnect}
						onDisconnect={props.onDisconnect}
					/>
				</>
			)}
		</ProviderCardShell>
	);
}

/**
 * PKCE 浏览器授权卡正文（OneDrive/Google 共用结构）：可选凭据输入 + 授权按钮 + 流程展示。
 * flowError 始终显示（轮询失败后 flow 区已清空），error 时不依赖 flow 区存在。
 */
function BrowserAuthProviderCard(props: {
	/** 图标与文案（OneDrive/Google 各自的 brand 资源与 i18n key）。 */
	icon: React.ReactNode;
	title: string;
	description: string;
	status: string;
	configured: boolean;
	/** 已内置应用凭据（构建期注入）：隐藏凭据输入，直接浏览器授权（对齐 Netcatty）。 */
	builtin?: boolean;
	connectLabel: string;
	onStart: () => void;
	startDisabled: boolean;
	onDisconnect: () => void;
	onReconnect?: () => void;
	credentials?: React.ReactNode;
	flow: { verificationUrl: string } | null;
	openUrlKey: Parameters<typeof t>[0];
	waitingKey: Parameters<typeof t>[0];
	flowError?: string | null;
}) {
	return (
		<ProviderCardShell
			icon={props.icon}
			title={props.title}
			description={props.description}
			status={props.status}
			configured={props.configured}
		>
			{() => (
				<>
					{props.credentials}
					<ProviderActionBar
						primaryLabel={props.connectLabel}
						onPrimary={props.onStart}
						primaryDisabled={props.startDisabled}
						configured={props.configured}
						status={props.status}
						onReconnect={props.onReconnect}
						onDisconnect={props.onDisconnect}
						removeVariant="outline"
					/>
					{props.flow ? (
						<div className="space-y-1 rounded-md bg-accent/40 px-3 py-2 text-sm">
							<div className="break-all">
								{t(props.openUrlKey)}{" "}
								<a className="text-primary underline" href={props.flow.verificationUrl} target="_blank" rel="noreferrer">{props.flow.verificationUrl}</a>
							</div>
							<div className="text-caption text-text-tertiary">{t(props.waitingKey)}</div>
						</div>
					) : null}
					{props.flowError ? (
						<div className="text-sm text-destructive">{props.flowError}</div>
					) : null}
				</>
			)}
		</ProviderCardShell>
	);
}

/** OneDrive 服务卡：PKCE 浏览器授权（token 只在主进程流转）。 */
export function OneDriveProviderCard(props: {
	status: string;
	configured: boolean;
	builtin?: boolean;
	clientId: string;
	onClientIdChange: (value: string) => void;
	onStart: () => void;
	onDisconnect: () => void;
	onReconnect?: () => void;
	flow: { verificationUrl: string } | null;
	flowError?: string | null;
}) {
	return (
		<BrowserAuthProviderCard
			icon={<Cloud size={16} />}
			title={t("cloudSync.provider.onedriveTitle")}
			description={t("cloudSync.provider.onedriveDesc")}
			status={props.status}
			configured={props.configured}
			builtin={props.builtin}
			connectLabel={t("cloudSync.provider.onedriveConnect")}
			onStart={props.onStart}
			startDisabled={!props.builtin && !props.clientId.trim()}
			onDisconnect={props.onDisconnect}
			onReconnect={props.onReconnect}
			flow={props.flow}
			openUrlKey="cloudSync.provider.onedriveOpenUrl"
			waitingKey="cloudSync.provider.onedriveWaiting"
			flowError={props.flowError}
			credentials={!props.builtin ? (
				<Field label={t("cloudSync.provider.onedriveClientId")}>
					<div className="space-y-1">
						<Input placeholder="00000000-0000-0000-0000-000000000000" value={props.clientId} onChange={(event) => props.onClientIdChange(event.target.value)} />
						<p className="text-caption text-text-tertiary">{t("cloudSync.provider.onedriveClientIdHint")}</p>
					</div>
				</Field>
			) : undefined}
		/>
	);
}

/** Google Drive 服务卡：PKCE 浏览器授权（额外可选 clientSecret）。 */
export function GoogleProviderCard(props: {
	status: string;
	configured: boolean;
	builtin?: boolean;
	clientId: string;
	clientSecret: string;
	onClientIdChange: (value: string) => void;
	onClientSecretChange: (value: string) => void;
	onStart: () => void;
	onDisconnect: () => void;
	onReconnect?: () => void;
	flow: { verificationUrl: string } | null;
	flowError?: string | null;
}) {
	return (
		<BrowserAuthProviderCard
			icon={<Globe size={16} />}
			title={t("cloudSync.provider.googleTitle")}
			description={t("cloudSync.provider.googleDesc")}
			status={props.status}
			configured={props.configured}
			builtin={props.builtin}
			connectLabel={t("cloudSync.provider.googleConnect")}
			onStart={props.onStart}
			startDisabled={!props.builtin && !props.clientId.trim()}
			onDisconnect={props.onDisconnect}
			onReconnect={props.onReconnect}
			flow={props.flow}
			openUrlKey="cloudSync.provider.googleOpenUrl"
			waitingKey="cloudSync.provider.googleWaiting"
			flowError={props.flowError}
			credentials={!props.builtin ? (
				<>
					<Field label={t("cloudSync.provider.googleClientId")}>
						<div className="space-y-1">
							<Input placeholder="1234567890-xxxxxxxx.apps.googleusercontent.com" value={props.clientId} onChange={(event) => props.onClientIdChange(event.target.value)} />
							<p className="text-caption text-text-tertiary">{t("cloudSync.provider.googleClientIdHint")}</p>
						</div>
					</Field>
					<Field label={t("cloudSync.provider.googleClientSecret")}>
						<SecretInput placeholder={t("cloudSync.provider.googleClientSecret")} value={props.clientSecret} onChange={props.onClientSecretChange} />
					</Field>
				</>
			) : undefined}
		/>
	);
}
