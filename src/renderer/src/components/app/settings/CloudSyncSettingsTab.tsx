import { useCallback, useState } from "react";
import {
	ChevronDown,
	ChevronRight,
	Cloud,
	Download,
	Eye,
	EyeOff,
	FileText,
	Folder,
	FolderOpen,
	Globe,
	KeyRound,
	Lock,
	Plus,
	Puzzle,
	RefreshCw,
	Settings2,
	ShieldCheck,
	Upload,
} from "lucide-react";
import { t, type TranslationKey } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { useCloudSync } from "../../../hooks/useCloudSync";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingBox } from "./SettingRows";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../ui-shadcn/collapsible";
import { Input } from "../../ui-shadcn/input";
import { Label } from "../../ui-shadcn/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui-shadcn/tabs";
import type {
	CloudSyncContentPreferences,
	CloudSyncProjectSelectionNode,
	CloudSyncProviderConfigInput,
	CloudSyncResourceCategory,
	CloudSyncSelectionTree,
} from "../../../../../shared/types";
import { cn } from "../../../lib/utils";
import { showNotice } from "../../../utils/notice";

const GLOBAL_SYNC_PROJECT_ID = "__global__";

/** GitHub 官方 mark（lucide 新版本移除了品牌图标，这里用内联 SVG）。 */
function GithubMarkIcon(props: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={props.className}>
			<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
		</svg>
	);
}

/** 表单字段：Label 在上 + 示例 placeholder（对齐 Netcatty 提示风格）。 */
function Field(props: { label: string; children: React.ReactNode }) {
	return (
		<div className="space-y-1.5">
			<Label className="text-xs text-text-tertiary">{props.label}</Label>
			{props.children}
		</div>
	);
}

/** 密码输入：右侧眼睛按钮切换明文/密文。 */
function SecretInput(props: { placeholder?: string; value: string; onChange: (value: string) => void }) {
	const [visible, setVisible] = useState(false);
	return (
		<div className="relative">
			<Input
				type={visible ? "text" : "password"}
				placeholder={props.placeholder}
				value={props.value}
				onChange={(event) => props.onChange(event.target.value)}
				className="pr-9"
			/>
			<button
				type="button"
				tabIndex={-1}
				aria-label={t("cloudSync.provider.showSecret")}
				title={t("cloudSync.provider.showSecret")}
				onClick={() => setVisible((prev) => !prev)}
				className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-foreground"
			>
				{visible ? <EyeOff size={15} /> : <Eye size={15} />}
			</button>
		</div>
	);
}

/** 全局配置分类开关：密钥/模型/生图随加密载荷同步；DSH 未实现时禁用。 */
const CONTENT_CATEGORIES: Array<{
	key: keyof CloudSyncContentPreferences;
	labelKey: TranslationKey;
	supported: boolean;
}> = [
	{ key: "desktopSettings", labelKey: "cloudSync.content.catDesktopSettings", supported: true },
	{ key: "piModels", labelKey: "cloudSync.content.catPiModels", supported: true },
	{ key: "piCredentials", labelKey: "cloudSync.content.catPiCredentials", supported: true },
	{ key: "imageGen", labelKey: "cloudSync.content.catImageGen", supported: true },
	{ key: "dshSettings", labelKey: "cloudSync.content.catDshSettings", supported: false },
	{ key: "dshCredentials", labelKey: "cloudSync.content.catDshCredentials", supported: false },
];

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
				props.status === "connected" ? "bg-success" : props.status === "connecting" ? "bg-warning" : props.status === "error" ? "bg-destructive" : "bg-text-tertiary/50",
			)}
		/>
	);
}

function ProviderCard(props: {
	provider: "webdav" | "s3";
	icon: React.ReactNode;
	title: string;
	description?: string;
	configured: boolean;
	status: string;
	account?: string;
	onConnect: (config: Record<string, unknown>) => void;
	onDisconnect: () => void;
	/** 已配置但未连接时的「连接」重试按钮。 */
	onReconnect?: () => void;
}) {
	const [editing, setEditing] = useState(false);
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
		<div className="overflow-hidden rounded-lg border border-border-subtle">
			<div
				className="flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 hover:bg-accent/40"
				role="button"
				tabIndex={0}
				onClick={() => setEditing((prev) => !prev)}
				onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setEditing((prev) => !prev); } }}
			>
				{editing ? <ChevronDown size={16} className="shrink-0 text-text-tertiary" /> : <ChevronRight size={16} className="shrink-0 text-text-tertiary" />}
				<span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">{props.icon}</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm font-medium">{props.title}</span>
					{props.description ? <span className="block truncate text-caption text-text-tertiary">{props.description}</span> : null}
				</span>
				{props.account ? <span className="shrink-0 truncate text-caption text-text-tertiary">{props.account}</span> : null}
				<span className="flex shrink-0 items-center gap-1.5 text-caption text-text-tertiary">
					<StatusDot status={props.status} />
					{props.status === "connected"
						? t("cloudSync.provider.connected")
						: props.status === "connecting"
							? t("cloudSync.provider.connecting")
							: props.status === "disconnected" && props.configured
								? t("cloudSync.provider.configured")
								: t("cloudSync.provider.disconnected")}
				</span>
			</div>
			{editing ? (
				<div className="space-y-3 border-t border-border-subtle px-4 py-4">
					{fields}
					<div className="flex flex-wrap items-center gap-2 pt-1">
						<Button size="sm" onClick={() => props.onConnect({ ...config, provider: props.provider })}>
							{t("cloudSync.provider.saveAndConnect")}
						</Button>
						<Button size="sm" variant="outline" onClick={() => setEditing(false)}>
							{t("common.cancel")}
						</Button>
						{props.configured && props.status === "disconnected" && props.onReconnect ? (
							<Button size="sm" variant="outline" onClick={props.onReconnect}>
								{t("cloudSync.provider.connect")}
							</Button>
						) : null}
						{props.configured ? (
							<Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={props.onDisconnect}>
								{t("cloudSync.provider.remove")}
							</Button>
						) : null}
					</div>
				</div>
			) : null}
		</div>
	);
}

/** GitHub 服务卡：与 ProviderCard 同款折叠式，正文为 Device Flow 连接区。 */
function GithubProviderCard(props: {
	status: string;
	configured: boolean;
	clientId: string;
	onClientIdChange: (value: string) => void;
	onConnect: () => void;
	onDisconnect: () => void;
	onReconnect?: () => void;
	flow: { userCode: string; verificationUrl: string; interval: number } | null;
}) {
	const [editing, setEditing] = useState(false);
	return (
		<div className="overflow-hidden rounded-lg border border-border-subtle">
			<div
				className="flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 hover:bg-accent/40"
				role="button"
				tabIndex={0}
				onClick={() => setEditing((prev) => !prev)}
				onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setEditing((prev) => !prev); } }}
			>
				{editing ? <ChevronDown size={16} className="shrink-0 text-text-tertiary" /> : <ChevronRight size={16} className="shrink-0 text-text-tertiary" />}
				<span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
					<GithubMarkIcon className="size-5" />
				</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm font-medium">{t("cloudSync.provider.githubTitle")}</span>
					<span className="block truncate text-caption text-text-tertiary">{t("cloudSync.provider.githubDesc")}</span>
				</span>
				<span className="flex shrink-0 items-center gap-1.5 text-caption text-text-tertiary">
					<StatusDot status={props.status} />
					{props.status === "connected"
						? t("cloudSync.provider.connected")
						: props.status === "disconnected" && props.configured
							? t("cloudSync.provider.configured")
							: t("cloudSync.provider.disconnected")}
				</span>
			</div>
			{editing ? (
				<div className="space-y-3 border-t border-border-subtle px-4 py-4">
					<Field label={t("cloudSync.provider.field.clientId")}>
						<div className="space-y-1">
							<Input placeholder="Iv23li…" value={props.clientId} onChange={(event) => props.onClientIdChange(event.target.value)} />
							<p className="text-caption text-text-tertiary">{t("cloudSync.provider.field.clientIdHint")}</p>
						</div>
					</Field>
					<div className="flex items-center gap-2">
						<Button size="sm" onClick={props.onConnect} disabled={!props.clientId.trim()}>
							{t("cloudSync.provider.githubConnect")}
						</Button>
						{props.configured && props.status === "disconnected" && props.onReconnect ? (
							<Button size="sm" variant="outline" onClick={props.onReconnect}>
								{t("cloudSync.provider.connect")}
							</Button>
						) : null}
						{props.configured ? (
							<Button size="sm" variant="outline" onClick={props.onDisconnect}>
								{t("cloudSync.provider.remove")}
							</Button>
						) : null}
					</div>
					{props.flow ? (
						<div className="space-y-1 rounded-md bg-accent/40 px-3 py-2 text-sm">
							<div className="break-all">{t("cloudSync.provider.githubOpenUrl")} <a className="text-primary underline" href={props.flow.verificationUrl} target="_blank" rel="noreferrer">{props.flow.verificationUrl}</a></div>
							<div>{t("cloudSync.provider.githubUserCode")} <code className="rounded bg-accent px-1.5 py-0.5 font-mono">{props.flow.userCode}</code></div>
							<div className="text-caption text-text-tertiary">{t("cloudSync.provider.githubWaiting")}</div>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/** 本地同步文件夹服务卡：选一个已被网盘客户端同步的本地文件夹，上传交给网盘客户端。 */
function LocalFolderProviderCard(props: {
	status: string;
	configured: boolean;
	onConnect: (folderPath: string) => void;
	onDisconnect: () => void;
	onReconnect?: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [folderPath, setFolderPath] = useState("");

	const browse = async () => {
		const picked = await desktopApi.dialog.pickFiles({ title: t("cloudSync.provider.localBrowse"), includeDirectories: true });
		if (picked.length > 0) setFolderPath(picked[0]);
	};

	return (
		<div className="overflow-hidden rounded-lg border border-border-subtle">
			<div
				className="flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 hover:bg-accent/40"
				role="button"
				tabIndex={0}
				onClick={() => setEditing((prev) => !prev)}
				onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setEditing((prev) => !prev); } }}
			>
				{editing ? <ChevronDown size={16} className="shrink-0 text-text-tertiary" /> : <ChevronRight size={16} className="shrink-0 text-text-tertiary" />}
				<span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
					<Folder size={16} />
				</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm font-medium">{t("cloudSync.provider.localTitle")}</span>
					<span className="block truncate text-caption text-text-tertiary">{t("cloudSync.provider.localDesc")}</span>
				</span>
				<span className="flex shrink-0 items-center gap-1.5 text-caption text-text-tertiary">
					<StatusDot status={props.status} />
					{props.status === "connected"
						? t("cloudSync.provider.connected")
						: props.status === "disconnected" && props.configured
							? t("cloudSync.provider.configured")
							: t("cloudSync.provider.disconnected")}
				</span>
			</div>
			{editing ? (
				<div className="space-y-3 border-t border-border-subtle px-4 py-4">
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
					<div className="flex flex-wrap items-center gap-2 pt-1">
						<Button size="sm" onClick={() => props.onConnect(folderPath.trim())} disabled={!folderPath.trim()}>
							{t("cloudSync.provider.saveAndConnect")}
						</Button>
						<Button size="sm" variant="outline" onClick={() => setEditing(false)}>
							{t("common.cancel")}
						</Button>
						{props.configured && props.status === "disconnected" && props.onReconnect ? (
							<Button size="sm" variant="outline" onClick={props.onReconnect}>
								{t("cloudSync.provider.connect")}
							</Button>
						) : null}
						{props.configured ? (
							<Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={props.onDisconnect}>
								{t("cloudSync.provider.remove")}
							</Button>
						) : null}
					</div>
				</div>
			) : null}
		</div>
	);
}

/** OneDrive 服务卡：PKCE 浏览器授权（token 只在主进程流转），镜像 GithubProviderCard 的轮询模式。 */
function OneDriveProviderCard(props: {
	status: string;
	configured: boolean;
	clientId: string;
	onClientIdChange: (value: string) => void;
	onStart: () => void;
	onDisconnect: () => void;
	onReconnect?: () => void;
	flow: { verificationUrl: string } | null;
	flowError?: string | null;
}) {
	const [editing, setEditing] = useState(false);
	return (
		<div className="overflow-hidden rounded-lg border border-border-subtle">
			<div
				className="flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 hover:bg-accent/40"
				role="button"
				tabIndex={0}
				onClick={() => setEditing((prev) => !prev)}
				onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setEditing((prev) => !prev); } }}
			>
				{editing ? <ChevronDown size={16} className="shrink-0 text-text-tertiary" /> : <ChevronRight size={16} className="shrink-0 text-text-tertiary" />}
				<span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
					<Cloud size={16} />
				</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm font-medium">{t("cloudSync.provider.onedriveTitle")}</span>
					<span className="block truncate text-caption text-text-tertiary">{t("cloudSync.provider.onedriveDesc")}</span>
				</span>
				<span className="flex shrink-0 items-center gap-1.5 text-caption text-text-tertiary">
					<StatusDot status={props.status} />
					{props.status === "connected"
						? t("cloudSync.provider.connected")
						: props.status === "disconnected" && props.configured
							? t("cloudSync.provider.configured")
							: t("cloudSync.provider.disconnected")}
				</span>
			</div>
			{editing ? (
				<div className="space-y-3 border-t border-border-subtle px-4 py-4">
					<Field label={t("cloudSync.provider.onedriveClientId")}>
						<div className="space-y-1">
							<Input placeholder="00000000-0000-0000-0000-000000000000" value={props.clientId} onChange={(event) => props.onClientIdChange(event.target.value)} />
							<p className="text-caption text-text-tertiary">{t("cloudSync.provider.onedriveClientIdHint")}</p>
						</div>
					</Field>
					<div className="flex flex-wrap items-center gap-2">
						<Button size="sm" onClick={props.onStart} disabled={!props.clientId.trim()}>
							{t("cloudSync.provider.onedriveConnect")}
						</Button>
						{props.configured && props.status === "disconnected" && props.onReconnect ? (
							<Button size="sm" variant="outline" onClick={props.onReconnect}>
								{t("cloudSync.provider.connect")}
							</Button>
						) : null}
						{props.configured ? (
							<Button size="sm" variant="outline" onClick={props.onDisconnect}>
								{t("cloudSync.provider.remove")}
							</Button>
						) : null}
					</div>
					{props.flow ? (
						<div className="space-y-1 rounded-md bg-accent/40 px-3 py-2 text-sm">
							<div className="break-all">
								{t("cloudSync.provider.onedriveOpenUrl")}{" "}
								<a className="text-primary underline" href={props.flow.verificationUrl} target="_blank" rel="noreferrer">{props.flow.verificationUrl}</a>
							</div>
							<div className="text-caption text-text-tertiary">{t("cloudSync.provider.onedriveWaiting")}</div>
						</div>
					) : null}
					{props.flowError ? (
						<div className="text-sm text-destructive">{props.flowError}</div>
					) : null}
				</div>
			) : null}
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
	label?: string;
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
				{props.label ? <span className="rounded bg-accent/70 px-1 py-px text-caption">{props.label}</span> : null}{" "}
				{props.relativePath}
			</span>
			{props.disabled && props.reason ? (
				<span className="shrink-0 text-caption text-warning" title={props.reason}>⚠</span>
			) : null}
		</label>
	);
}

/** 类别分组头：复选框 + 类别名 + (选中/总数)。勾上 = 该类全部同步（纯二元，无三态中继）。 */
function CategoryHeader(props: {
	label: string;
	total: number;
	selected: number;
	onToggle: (selected: boolean) => void;
}) {
	const allSelected = props.total > 0 && props.selected === props.total;
	return (
		<label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/50">
			<Checkbox checked={allSelected} onCheckedChange={() => props.onToggle(!allSelected)} />
			<span className="min-w-0 flex-1 truncate text-caption font-medium text-text-tertiary">{props.label}</span>
			<span className="shrink-0 text-caption text-text-tertiary">{props.selected}/{props.total}</span>
		</label>
	);
}

/** 资源类别在树内的展示顺序：全局节点含 config，项目节点含 settings。 */
function categoryOrder(isGlobal: boolean): CloudSyncResourceCategory[] {
	return isGlobal ? ["prompts", "skills", "extensions", "config"] : ["prompts", "skills", "extensions", "settings"];
}

/** 项目选择节点：可折叠；节点头部全选会话，展开后按类别分组（M9 §12.2）。 */
function ProjectSelectionNode(props: {
	node: CloudSyncProjectSelectionNode;
	expanded: boolean;
	onToggleExpanded: () => void;
	onToggleSession: (selectionId: string) => void;
	onToggleResource: (selectionId: string) => void;
	onToggleNodeSessions: (projectId: string, all: boolean) => void;
	/** M9：类别分组批量勾选（sessions 或资源类别）。 */
	onToggleCategory: (projectId: string, category: "sessions" | CloudSyncResourceCategory, selected: boolean) => void;
	/** M9：云端待映射项目 → 手动指定本地同步目录（接线点，当前占位）。 */
	onMountProject?: (remoteProjectId: string, name: string) => void;
	/** 实时选择集合（勾选态/计数以集合为准，不依赖扫描快照）。 */
	sessionSelection: ReadonlySet<string>;
	resourceSelection: ReadonlySet<string>;
}) {
	const { node } = props;
	const isGlobal = node.projectId === GLOBAL_SYNC_PROJECT_ID;
	const sessionsSelectedCount = node.sessions.filter((session) => props.sessionSelection.has(session.selectionId)).length;
	const sessionCount = node.sessions.length;
	const resourcesSelectedCount = node.resources.filter((resource) => props.resourceSelection.has(resource.selectionId)).length;
	const resourceCount = node.resources.length;

	return (
		<Collapsible open={props.expanded} onOpenChange={props.onToggleExpanded} className="rounded-lg border border-border-subtle bg-background/40">
			<CollapsibleTrigger asChild>
				<div className="flex w-full cursor-pointer items-center gap-2 px-3 py-2" role="button" tabIndex={0}>
					{props.expanded ? <ChevronDown size={15} className="shrink-0 text-text-tertiary" /> : <ChevronRight size={15} className="shrink-0 text-text-tertiary" />}
					{isGlobal ? <Globe size={15} className="shrink-0 text-primary" /> : <Folder size={15} className="shrink-0 text-text-tertiary" />}
					<Checkbox
						checked={sessionCount > 0 && sessionsSelectedCount === sessionCount}
						onCheckedChange={() => props.onToggleNodeSessions(node.projectId, sessionsSelectedCount < sessionCount)}
						onClick={(event) => event.stopPropagation()}
					/>
					<span className="min-w-0 flex-1 truncate text-sm font-medium">{node.name}</span>
					{node.missing ? (
						<>
							<span className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-caption text-warning">{t("cloudSync.content.missingProject")}</span>
							<Button
								size="sm"
								variant="outline"
								className="shrink-0 px-2 text-caption"
								title={t("cloudSync.tree.mountHereHint")}
								onClick={(event) => {
									event.stopPropagation();
									props.onMountProject?.(node.projectId, node.name);
								}}
							>
								{t("cloudSync.tree.mountHere")}
							</Button>
						</>
					) : null}
					<span className="shrink-0 text-caption text-text-tertiary">
						{sessionCount > 0 ? t("cloudSync.content.sessionCount", { count: sessionCount, selected: sessionsSelectedCount }) : null}
						{resourceCount > 0 ? (sessionCount > 0 ? " · " : "") + t("cloudSync.content.resourceCount", { count: resourceCount }) : null}
					</span>
				</div>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="space-y-1 border-t border-border-subtle px-2 py-2">
					{node.sessions.length > 0 ? (
						<div className="space-y-0.5">
							<CategoryHeader
								label={t("cloudSync.tree.sessions")}
								total={node.sessions.length}
								selected={sessionsSelectedCount}
								onToggle={(selected) => props.onToggleCategory(node.projectId, "sessions", selected)}
							/>
							<div className="space-y-0.5 pl-5">
								{node.sessions.map((session) => (
									<SessionRow
										key={session.selectionId}
										title={session.title}
										relativePath={session.relativePath}
										selected={props.sessionSelection.has(session.selectionId)}
										disabled={session.status === "unavailable"}
										reason={session.reason}
										onToggle={() => props.onToggleSession(session.selectionId)}
									/>
								))}
							</div>
						</div>
					) : null}
					{categoryOrder(isGlobal).map((category) => {
						const items = node.resources.filter((resource) => resource.category === category);
						if (items.length === 0) return null;
						const selected = items.filter((resource) => props.resourceSelection.has(resource.selectionId)).length;
						return (
							<div key={category} className="space-y-0.5 pt-1">
								<CategoryHeader
									label={t(`cloudSync.tree.${category}` as TranslationKey)}
									total={items.length}
									selected={selected}
									onToggle={(all) => props.onToggleCategory(node.projectId, category, all)}
								/>
								<div className="space-y-0.5 pl-5">
									{items.map((resource) => (
										<ResourceRow
											key={resource.selectionId}
											relativePath={resource.relativePath}
											selected={props.resourceSelection.has(resource.selectionId)}
											disabled={resource.status === "unavailable"}
											reason={resource.reason}
											onToggle={() => props.onToggleResource(resource.selectionId)}
										/>
									))}
								</div>
							</div>
						);
					})}
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
		connect,
		oneDriveStart,
		oneDrivePoll,
		setAutoSync,
		setStrategy,
		exportBackup,
		importBackup,
		pickCustomPath,
		pickMountDirectory,
		mountProject,
		unmountProject,
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
	/** 本地备份导入表单状态。 */
	const [importFilePath, setImportFilePath] = useState("");
	const [importPassword, setImportPassword] = useState("");
	const [importMode, setImportMode] = useState<"merge" | "overwrite" | "restoreMissing">("merge");

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

	/** M9：类别分组批量勾选 —— 全选/取消该类所有候选（操作现有选择集合，不引入新 IPC）。 */
	const toggleCategory = useCallback((projectId: string, category: "sessions" | CloudSyncResourceCategory, selected: boolean) => {
		const node = selectionTree?.projects.find((candidate) => candidate.projectId === projectId);
		if (!node) return;
		if (category === "sessions") {
			setSelectedSessionIds((prev) => {
				const next = new Set(prev);
				for (const session of node.sessions) {
					if (selected) next.add(session.selectionId);
					else next.delete(session.selectionId);
				}
				return next;
			});
			return;
		}
		setSelectedResourceIds((prev) => {
			const next = new Set(prev);
			for (const resource of node.resources) {
				if (resource.category !== category) continue;
				if (selected) next.add(resource.selectionId);
				else next.delete(resource.selectionId);
			}
			return next;
		});
	}, [selectionTree]);

	/** M9：弹文件/文件夹选择器（主进程归属计算），把自选路径加入同步清单。 */
	const onAddCustomPath = useCallback(async () => {
		await pickCustomPath();
		void scan();
	}, [pickCustomPath, scan]);

	/** M9：云端项目手动挂载 —— 弹目录选择器 → mount-project 持久化映射。 */
	const onMountProject = useCallback(async (remoteProjectId: string, name: string) => {
		const localPath = await pickMountDirectory();
		if (!localPath) return;
		await mountProject({ remoteProjectId, remoteProjectName: name, localPath });
	}, [pickMountDirectory, mountProject]);

	/** M9：解除挂载映射。 */
	const onUnmountProject = useCallback((remoteProjectId: string) => {
		void unmountProject(remoteProjectId);
	}, [unmountProject]);

	const toggleExpanded = useCallback((projectId: string) => {
		setExpandedProjectIds((prev) => {
			const next = new Set(prev);
			if (next.has(projectId)) next.delete(projectId);
			else next.add(projectId);
			return next;
		});
	}, []);

	/** 内容分类开关（密钥/模型/生图等）：随选择一并持久化。 */
	const toggleContentCategory = useCallback((key: keyof CloudSyncContentPreferences, checked: boolean) => {
		void updateSelection({
			selectedSessionIds: [...selectedSessionIds],
			selectedResourceIds: [...selectedResourceIds],
			content: { [key]: checked },
		});
	}, [updateSelection, selectedSessionIds, selectedResourceIds]);

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

	// ── 本地备份：导出 / 导入（离线，无需云服务） ──

	const handleExport = useCallback(async () => {
		const result = await exportBackup({ title: t("cloudSync.backup.exportTitle") });
		if (result === undefined) return; // 失败已写入 error
		if (result === null) {
			showNotice(t("cloudSync.backup.exportCanceled"), 2000, "info");
			return;
		}
		showNotice(
			t("cloudSync.backup.exportDone", { path: result.filePath, sessions: result.sessionCount, resources: result.resourceCount }),
			5000,
			"info",
		);
	}, [exportBackup]);

	const handlePickImportFile = useCallback(async () => {
		const picked = await desktopApi.dialog.pickFiles({ title: t("cloudSync.backup.importPick") });
		if (picked.length > 0) setImportFilePath(picked[0]);
	}, []);

	const handleImport = useCallback(async () => {
		if (!importFilePath || !importPassword) return;
		const result = await importBackup({ filePath: importFilePath, password: importPassword, mode: importMode });
		if (!result) return; // 失败已写入 error
		const skipped = result.sessionsSkipped + result.resourcesSkipped;
		const pending = result.pendingProjects.length;
		const message = t("cloudSync.backup.importDone", {
			restored: result.sessionsRestored,
			resourcesRestored: result.resourcesRestored,
			skipped,
		}) + (pending > 0 ? t("cloudSync.backup.importPending", { count: pending }) : "");
		showNotice(message, 5000, "info");
	}, [importBackup, importFilePath, importPassword, importMode]);

	const providers = state?.providers;
	const webdavSnapshot = providers?.webdav;
	const s3Snapshot = providers?.s3;
	const githubSnapshot = providers?.github;
	const localSnapshot = providers?.local;
	const onedriveSnapshot = providers?.onedrive;

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

	// OneDrive 浏览器授权：PKCE 流程在设置页内轮询，token 永不进渲染层。
	const [onedriveClientId, setOnedriveClientId] = useState("");
	const [onedriveFlow, setOnedriveFlow] = useState<{ verificationUrl: string } | null>(null);
	const [onedriveFlowError, setOnedriveFlowError] = useState<string | null>(null);
	const startOneDriveConnect = useCallback(async () => {
		setOnedriveFlowError(null);
		const flow = await oneDriveStart(onedriveClientId.trim());
		if (!flow) return;
		setOnedriveFlow({ verificationUrl: flow.verificationUrl });
		const timer = window.setInterval(async () => {
			const result = await oneDrivePoll();
			if (!result) return;
			if (result.status !== "pending") {
				window.clearInterval(timer);
				setOnedriveFlow(null);
				if (result.status === "error") {
					setOnedriveFlowError(result.error ?? "OneDrive authorization failed");
				}
			}
		}, 5000);
	}, [oneDriveStart, oneDrivePoll, onedriveClientId]);
	// 组件卸载时清理轮询定时器（startOneDriveConnect 的 timer 是局部变量，
	// 由 polling 回调自行清理；组件卸载时 flow 状态清空即可）。
	useEffect(() => {
		return () => {
			setOnedriveFlow(null);
		};
	}, []);

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
									/>
									<GithubProviderCard
										status={githubSnapshot?.status ?? "disconnected"}
										configured={Boolean(githubSnapshot?.configured)}
										clientId={githubClientId}
										onClientIdChange={setGithubClientId}
										onConnect={() => void startGithubConnect()}
										onDisconnect={() => void disconnectProvider("github")}
										flow={githubFlow}
									/>
									<LocalFolderProviderCard
										status={localSnapshot?.status ?? "disconnected"}
										configured={Boolean(localSnapshot?.configured)}
										onConnect={(folderPath) => {
											// 主进程 normalizeLocalFolderConfig 会校验绝对路径等约束。
											void configureProvider({ provider: "local", config: { folderPath } });
										}}
										onDisconnect={() => void disconnectProvider("local")}
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
										{CONTENT_CATEGORIES.map((category) => (
											<label
												key={category.key}
												className={cn(
													"flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50",
													!category.supported && "cursor-not-allowed opacity-60",
												)}
											>
												<Checkbox
													checked={Boolean(selectionTree.content[category.key])}
													disabled={!category.supported}
													onCheckedChange={(checked) => toggleContentCategory(category.key, Boolean(checked))}
												/>
												<span className="min-w-0 flex-1 truncate">{t(category.labelKey)}</span>
												{!category.supported ? <span className="shrink-0 text-caption text-text-tertiary">{t("cloudSync.content.notSupported")}</span> : null}
											</label>
										))}
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
											onToggleSession={toggleSession}
											onToggleResource={toggleResource}
											onToggleNodeSessions={toggleNodeSessions}
											onToggleCategory={toggleCategory}
											onMountProject={onMountProject}
											sessionSelection={selectedSessionIds}
											resourceSelection={selectedResourceIds}
										/>
									))}
									<div className="pt-1">
										<Button size="sm" variant="outline" onClick={() => void onAddCustomPath()}>
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
											<Button size="sm" variant="ghost" className="text-text-tertiary hover:text-destructive" onClick={() => onUnmountProject(mount.remoteProjectId)}>
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
									<Button size="sm" onClick={() => void handleExport()} loading={busy}>
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
											value={importFilePath}
											onChange={(event) => setImportFilePath(event.target.value)}
											placeholder="pideck-backup-2026-08-01.pideckbackup"
											className="min-w-0 flex-1"
										/>
										<Button size="sm" variant="outline" onClick={() => void handlePickImportFile()}>
											<FolderOpen size={14} /> {t("cloudSync.backup.importPick")}
										</Button>
									</div>
								</Field>
								<Field label={t("cloudSync.backup.importPassword")}>
									<SecretInput placeholder={t("cloudSync.backup.importPassword")} value={importPassword} onChange={setImportPassword} />
								</Field>
								<Field label={t("cloudSync.backup.importMode")}>
									<Select value={importMode} onValueChange={(value) => setImportMode(value as "merge" | "overwrite" | "restoreMissing")}>
										<SelectTrigger className="w-full max-w-sm"><SelectValue /></SelectTrigger>
										<SelectContent>
											<SelectItem value="merge">{t("cloudSync.backup.importModeMerge")}</SelectItem>
											<SelectItem value="overwrite">{t("cloudSync.backup.importModeOverwrite")}</SelectItem>
											<SelectItem value="restoreMissing">{t("cloudSync.backup.importModeRestoreMissing")}</SelectItem>
										</SelectContent>
									</Select>
								</Field>
								<Button size="sm" onClick={() => void handleImport()} loading={busy} disabled={!importFilePath.trim() || !importPassword}>
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
