import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, ChevronDown, Eye, EyeOff, FileCode, FolderOpen, Search, Server, TerminalSquare } from "lucide-react";
import { detectRendererPlatform } from "../../../lib/detectRendererPlatform";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { Input } from "../../ui-shadcn/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../../ui-shadcn/popover";
import { Label } from "../../ui-shadcn/label";
import type { RemoteHostAddInput, RemoteHostConfigCandidate } from "../../../../../shared/types/remoteHost";
import type { WslHostListItem } from "../../../../../shared/types/wslHost";

/** 跳过原因是稳定枚举；这里显式映射而不是拼接 key，否则远端回来的任意字符串会拼出不存在的 key。 */
function skipReasonLabel(reason: string): string {
	switch (reason) {
		case "wildcard":
			return t("settings.connections.add.skipReason.wildcard");
		case "invalid":
			return t("settings.connections.add.skipReason.invalid");
		case "unsupported-directive":
			return t("settings.connections.add.skipReason.unsupported-directive");
		default:
			return reason;
	}
}

/**
 * 添加/测试失败时的稳定码 → 人话。
 *
 * 以前这里只有一个 `{ code }` 占位：用户看到 SSH_HOST_AUTHENTICATION_FAILED 完全不知道该改哪个字段。
 * 私钥被拒、私钥读不了、私钥带口令、网络不通，这四类的下一步动作完全不同，必须分开讲。
 */
function addFailureReason(code: string): string {
	switch (code) {
		case "SSH_AUTH_KEY_REJECTED":
			return t("settings.connections.add.reason.keyRejected");
		case "SSH_AUTH_KEY_UNREADABLE":
		case "SSH_HOST_KEY_INVALID":
			return t("settings.connections.add.reason.keyUnreadable");
		case "SSH_AUTH_PASSPHRASE_REQUIRED":
			return t("settings.connections.add.reason.passphraseRequired");
		case "SSH_HOST_UNREACHABLE":
			return t("settings.connections.add.reason.unreachable");
		case "SSH_HOST_COMMAND_TIMEOUT":
			return t("settings.connections.add.reason.timeout");
		case "SSH_HOST_AUTHENTICATION_FAILED":
			return t("settings.connections.add.reason.authFailed");
		case "REMOTE_HOST_IDENTITY_FILE_INVALID":
		case "INVALID_SSH_LOCAL_PATH":
			return t("settings.connections.add.reason.keyPathInvalid");
		case "REMOTE_FEATURE_DISABLED":
			return t("settings.connections.add.disabled");
		default:
			return t("settings.connections.add.failed", { code });
	}
}

type AuthMode = "agent" | "key" | "password";
type ConnectionKind = "ssh" | "wsl";

/** 表单初值：端口默认 22，认证默认交给 ssh-agent / 默认密钥（与 Transport 的 BatchMode 一致）。 */
const EMPTY_FORM = { label: "", hostName: "", port: "22", user: "", auth: "agent" as AuthMode, identityFile: "", password: "", passphrase: "" };
type FormState = typeof EMPTY_FORM;

/**
 * 「新建连接」面板。
 *
 * 结构照 ZCode 的远程配置面板：**类型切换 + 实时目标预览 + 表单 + 从 SSH config 导入**。
 * SSH 与 WSL 都在这里创建：SSH 建远端主机（pin/TOFU），WSL 建本机档案（distro/user）。
 * 两者信任模型不同，但入口与表单骨架共用；Docker 没有后端，保持 disabled 并说明。
 *
 * 认证提供「自动（ssh-agent/默认密钥）」「指定私钥」与「密码」：密码模式由主进程用一次性
 * askpass 桥回答 OpenSSH 的 password 提问，口令只在本次运行的内存里，既不落盘也不进 argv/env。
 *
 * 保存仍是「一次动作」：主进程在同一次 add 里完成首次 host key 信任（TOFU）并落盘 pin，
 * 成功后由调用方立刻发起连接，没有第二步「核对指纹」。
 */
/** 编辑一台已添加主机时的初值：字段来自 store，口令来自系统加密存储（可能为空）。 */
export type AddHostEditSeed = { hostId: string; label: string; hostName: string; user?: string; port?: number; identityFile?: string; authMethod?: "password"; secret?: string };

export function AddHostDialog(props: { onClose: () => void; onSubmitted: (hostId: string, label: string, password?: string) => void; onWslSubmitted?: (host: WslHostListItem) => void; initialKind?: ConnectionKind; edit?: AddHostEditSeed }) {
	const editing = props.edit;
	const [kind, setKind] = useState<ConnectionKind>(props.initialKind ?? "ssh");
	const [candidates, setCandidates] = useState<RemoteHostConfigCandidate[]>([]);
	const [skipped, setSkipped] = useState<{ alias: string; reason: string }[]>([]);
	const [identityFiles, setIdentityFiles] = useState<string[]>([]);
	const [currentUser, setCurrentUser] = useState("");
	const [scanNote, setScanNote] = useState<string | null>(null);
	const [importing, setImporting] = useState(false);
	/** 私钥候选下拉：点输入框或右侧箭头打开，选中即填入。 */
	const [identityOpen, setIdentityOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [form, setForm] = useState<FormState>(() => {
		if (editing === undefined) return EMPTY_FORM;
		// 口令按认证方式回到它原本的输入框：密码模式是登录口令，私钥模式是私钥口令。
		const secret = editing.secret ?? "";
		return {
			label: editing.label,
			hostName: editing.hostName,
			port: editing.port === undefined ? "22" : String(editing.port),
			user: editing.user ?? "",
			auth: editing.authMethod === "password" ? "password" : editing.identityFile === undefined ? "agent" : "key",
			identityFile: editing.identityFile ?? "",
			password: editing.authMethod === "password" ? secret : "",
			passphrase: editing.authMethod === "password" ? "" : secret,
		};
	});
	const [showSecret, setShowSecret] = useState(false);
	// 密码与密钥口令是两个独立字段：共用一个可见态会让「看密码」顺手把口令也揭开。
	const [showPassword, setShowPassword] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// WSL 档案：只保存显示名/发行版/Linux 用户，目录在「添加项目」时选。
	const [wsl, setWsl] = useState({ label: "", distro: "", user: "" });
	const [wslBusy, setWslBusy] = useState(false);
	// 「测试连接」：只握手不落库。结果分成功（带主机密钥指纹）与失败（已翻译成行动建议）。
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<{ ok: true; fingerprint: string } | { ok: false; reason: string } | null>(null);
	const [wslError, setWslError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void (async () => {
			const result = await desktopApi.remoteHosts.scanConfig();
			if (!active) return;
			if (!result.ok) {
				// 功能被关闭时直接说明；config 读不到时表单仍然可用，不把用户堵在错误页。
				setScanNote(result.code === "REMOTE_FEATURE_DISABLED" ? t("settings.connections.add.disabled") : t("settings.connections.add.scanFailed"));
				return;
			}
			setCandidates(result.candidates);
			setSkipped(result.skipped);
			setIdentityFiles(result.identityFiles);
			setCurrentUser(result.user);
		})();
		return () => {
			active = false;
		};
	}, []);

	/** 表单唯一的校验点（与 ZCode 的 collectRemoteFormFieldErrors 同一思路：先报第一个错，不发请求）。 */
	const validate = useCallback((): RemoteHostAddInput | string => {
		const label = form.label.trim();
		const hostName = form.hostName.trim();
		if (label.length === 0 || hostName.length === 0) return t("settings.connections.add.required");
		const rawPort = form.port.trim();
		const port = rawPort.length === 0 ? undefined : Number(rawPort);
		if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) return t("settings.connections.add.badPort");
		const identityFile = form.auth === "key" ? form.identityFile.trim() : "";
		if (form.auth === "key" && identityFile.length === 0) return t("settings.connections.add.keyRequired");
		// The password is only carried by this request: it is never persisted, and main keeps it in memory
		// for the lifetime of the connection only.
		const password = form.auth === "password" ? form.password : "";
		// 编辑时留空表示「沿用已保存的口令」，只有新建才要求当场填写。
		if (form.auth === "password" && password.length === 0 && editing === undefined) return t("settings.connections.add.passwordRequired");
		const user = form.user.trim();
		return { label, hostName, ...(port === undefined ? {} : { port }), ...(user.length > 0 ? { user } : {}), ...(identityFile.length > 0 ? { identityFile } : {}), ...(form.auth === "password" ? { authMethod: "password" as const } : {}) };
	}, [form]);

	const submit = useCallback(async () => {
		const input = validate();
		if (typeof input === "string") {
			setError(input);
			return;
		}
		setBusy(true);
		setError(null);
		const secret = form.auth === "password" ? form.password : form.auth === "key" ? form.passphrase : "";
		try {
			if (editing !== undefined) {
				const result = await desktopApi.remoteHosts.update({
					hostId: editing.hostId,
					patch: {
						label: input.label,
						hostName: input.hostName,
						user: input.user ?? "",
						port: typeof input.port === "number" ? input.port : undefined,
						identityFile: input.identityFile ?? "",
						// 显式写入 undefined：从密码切回密钥/agent 时必须清掉旧的 authMethod。
						authMethod: input.authMethod === "password" ? ("password" as const) : undefined,
					},
					// 空口令 = 不覆盖；用户显式输入了才更新存储。
					...(secret.length > 0 ? { secret } : {}),
				});
				if (result.ok) props.onSubmitted(result.hostId, input.label, secret.length > 0 ? secret : undefined);
				else if (result.saved) setError(t("settings.connections.edit.savedUnverified", { code: result.code }));
				else setError(addFailureReason(result.code));
				return;
			}
			const result = await desktopApi.remoteHosts.add(input);
			// 回传 label 让连接进度屏显示人话，而不是 UUID。
			if (result.ok) props.onSubmitted(result.hostId, input.label, secret.length > 0 ? secret : undefined);
			else setError(addFailureReason(result.code));
		} finally {
			setBusy(false);
		}
	}, [props, validate]);

	// 表单里的连接参数一变，上一次「测试连接」的结论就作废：留着旧的「连接成功」会让人以为新配置也通了。
	useEffect(() => {
		setTestResult(null);
	}, [form.hostName, form.port, form.user, form.identityFile, form.auth, form.passphrase]);

	/** 用当前表单值做一次真实握手（不保存、不写 pin），把失败定位到字段而不是保存后的连接进度框。 */
	const testConnection = useCallback(async () => {
		const input = validate();
		if (typeof input === "string") {
			setError(input);
			return;
		}
		setError(null);
		setTestResult(null);
		setTesting(true);
		try {
			const result = await desktopApi.remoteHosts.test(input);
			setTestResult(result.ok ? { ok: true, fingerprint: result.fingerprint } : { ok: false, reason: addFailureReason(result.code) });
		} finally {
			setTesting(false);
		}
	}, [validate]);

	/** 选中一条 config 候选 = 把字段填进表单，仍然由用户确认后再添加（不隐式提交）。 */
	const applyCandidate = useCallback((candidate: RemoteHostConfigCandidate) => {
		setForm({
			label: candidate.alias,
			hostName: candidate.hostName,
			port: candidate.port === null ? "22" : String(candidate.port),
			user: candidate.user,
			auth: candidate.identityFile === null ? "agent" : "key",
			identityFile: candidate.identityFile ?? "",
			password: "",
			passphrase: "",
		});
		setError(null);
		setImporting(false);
		setQuery("");
	}, []);

	// 从 SSH config 里已经出现的私钥路径作为候选；用户不必再去文件管理器里翻一遍。
	// 两个来源合并：config 里显式写过的私钥优先，其次是 ~/.ssh 里按命名约定扫描到的文件。
	const identitySuggestions = useMemo(() => {
		const fromConfig = candidates.map((candidate) => candidate.identityFile).filter((path): path is string => typeof path === "string" && path.length > 0);
		return [...new Set([...fromConfig, ...identityFiles])].slice(0, 8);
	}, [candidates, identityFiles]);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (needle.length === 0) return candidates;
		return candidates.filter((candidate) => `${candidate.alias} ${candidate.hostName} ${candidate.user}`.toLowerCase().includes(needle));
	}, [candidates, query]);

	const previewHost = form.hostName.trim();
	const previewUser = form.user.trim();
	const previewPort = form.port.trim() || "22";
	const preview = kind === "wsl" ? t("settings.connections.add.wsl.preview") : previewHost.length === 0 ? t("settings.connections.add.previewPlaceholder") : `${previewUser.length > 0 ? `${previewUser}@` : ""}${previewHost}:${previewPort}`;
	// WSL 只有 Windows 宿主才有：其它平台不渲染这一页（与 ZCode buildAvailableKinds 同判据）。
	const wslSupported = detectRendererPlatform() === "win32";

	/** 创建 WSL 档案：主进程只写本机清单，不启动 wsl.exe；引用保护在移除时生效。 */
	const submitWsl = useCallback(async () => {
		const label = wsl.label.trim();
		const distro = wsl.distro.trim();
		const user = wsl.user.trim();
		if (label.length === 0 || !/^[A-Za-z0-9._-]{1,64}$/u.test(distro) || !/^[A-Za-z_][A-Za-z0-9._-]{0,31}$/u.test(user)) {
			setWslError(t("settings.connections.add.wsl.invalid"));
			return;
		}
		setWslBusy(true);
		setWslError(null);
		try {
			const result = await desktopApi.remoteHosts.addWslHost({ label, distro, user });
			if (result.ok) props.onWslSubmitted?.(result.host);
			else setWslError(t("settings.connections.add.wsl.failed", { code: result.code }));
		} finally {
			setWslBusy(false);
		}
	}, [props, wsl]);

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
		>
			{/* scroll-ok: bounded 表单对话框整页滚动，字段数量固定且由 max-h 收束 */}
			<DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto p-6 sm:max-w-3xl sm:p-8">
				<DialogHeader className="pr-8">
					<DialogTitle className="text-lg font-medium">{editing === undefined ? t("settings.connections.add.title") : t("settings.connections.edit.title")}</DialogTitle>
					<DialogDescription className={cn("break-all font-mono text-label", kind === "ssh" && previewHost.length > 0 ? "text-foreground" : "text-muted-foreground")}>{preview}</DialogDescription>
				</DialogHeader>

				{/* 类型切换：SSH 建远端主机，WSL 建本机档案；Docker 还没有后端。 */}
				<div className={cn("flex flex-wrap items-center justify-between gap-2", editing !== undefined && "hidden")}>
					<div role="group" aria-label={t("settings.connections.add.typeLabel")} className="flex w-fit overflow-hidden rounded-lg border border-input">
						<button type="button" aria-pressed={kind === "ssh"} className={cn("inline-flex min-h-8 items-center gap-1.5 px-3 text-body", kind === "ssh" ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-bg-hover")} onClick={() => setKind("ssh")}>
							<Server className="size-3.5" aria-hidden="true" />
							{t("settings.connections.add.kind.ssh")}
						</button>
						{wslSupported ? (
							<button type="button" aria-pressed={kind === "wsl"} className={cn("inline-flex min-h-8 items-center gap-1.5 border-l border-input px-3 text-body", kind === "wsl" ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-bg-hover")} onClick={() => setKind("wsl")}>
								<TerminalSquare className="size-3.5" aria-hidden="true" />
								{t("settings.connections.add.kind.wsl")}
							</button>
						) : null}
						<button
							type="button"
							aria-pressed="false"
							disabled
							aria-label={`${t("settings.connections.add.kind.docker")} — ${t("settings.connections.add.kindUnavailable")}`}
							title={t("settings.connections.add.kindUnavailable")}
							className="inline-flex min-h-8 cursor-not-allowed items-center gap-1.5 border-l border-input px-3 text-body text-muted-foreground opacity-50"
						>
							<Box className="size-3.5" aria-hidden="true" />
							{t("settings.connections.add.kind.docker")}
						</button>
					</div>
					{kind === "ssh" ? (
						<Popover open={importing} onOpenChange={setImporting}>
							<PopoverTrigger asChild>
								<Button type="button" variant="ghost" size="sm" className={cn("text-muted-foreground", importing && "bg-bg-hover text-foreground")} aria-expanded={importing}>
									<FileCode className="size-4" aria-hidden="true" />
									{t("settings.connections.add.import")}
									<ChevronDown className={cn("size-3.5 transition-transform", importing && "rotate-180")} aria-hidden="true" />
								</Button>
							</PopoverTrigger>
							{/* 小浮层：只覆盖在表单之上，不把下面的字段推下去。 */}
							<PopoverContent align="end" sideOffset={6} className="w-[21rem] p-0">
								<div className="overflow-hidden" data-testid="ssh-config-import">
									<div className="relative border-b border-border-subtle/70 p-1.5">
										<Search className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
										<Input autoFocus value={query} placeholder={t("settings.connections.add.importSearch")} aria-label={t("settings.connections.add.importSearch")} onChange={(event) => setQuery(event.target.value)} className="h-8 border-0 bg-transparent pl-7 text-body shadow-none focus-visible:ring-0" />
									</div>
									{/* scroll-ok: bounded SSH config 候选，扫描结果由 max-h 收束 */}
									<div className="max-h-56 overflow-y-auto p-1">
										{filtered.length === 0 ? (
											<div className="flex flex-col items-center gap-1.5 px-3 py-7 text-center">
												<Search className="size-4 text-muted-foreground/60" aria-hidden="true" />
												<p className="text-body text-muted-foreground">{t("settings.connections.add.importEmpty")}</p>
											</div>
										) : (
											<ul className="flex flex-col gap-0.5">
												{filtered.map((candidate) => (
													<li key={candidate.alias}>
														<button type="button" className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-bg-hover focus-visible:bg-bg-hover" onClick={() => applyCandidate(candidate)}>
															<span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg-input text-muted-foreground transition-colors group-hover:text-foreground">
																<Server className="size-4" aria-hidden="true" />
															</span>
															<span className="flex min-w-0 flex-1 flex-col gap-0.5">
																<span className="truncate text-body font-medium text-foreground">{candidate.alias}</span>
																<span className="truncate font-mono text-label text-muted-foreground">
																	{candidate.user.length > 0 ? candidate.user : currentUser}@{candidate.hostName}
																	{candidate.port !== null ? `:${candidate.port}` : ""}
																</span>
															</span>
														</button>
													</li>
												))}
											</ul>
										)}
									</div>
									{/* 被跳过的条目要说明原因：静默少一项会让用户以为自己的配置丢了。 */}
									{skipped.length > 0 || scanNote !== null ? (
										<div className="border-t border-border-subtle/70 px-3 py-1.5">
											{skipped.length > 0 ? (
												<details className="text-label text-muted-foreground">
													<summary className="cursor-pointer select-none py-0.5">{t("settings.connections.add.skipped", { count: String(skipped.length) })}</summary>
													<ul className="flex flex-col gap-0.5 pb-1">
														{skipped.map((entry) => (
															<li key={`${entry.alias}-${entry.reason}`}>
																{entry.alias} — {skipReasonLabel(entry.reason)}
															</li>
														))}
													</ul>
												</details>
											) : null}
											{scanNote !== null ? <p className="py-0.5 text-label text-muted-foreground">{scanNote}</p> : null}
										</div>
									) : null}
								</div>
							</PopoverContent>
						</Popover>
					) : null}
				</div>

				{kind === "wsl" ? (
					<div className="flex flex-col gap-3">
						<p className="text-label text-muted-foreground">{t("settings.connections.add.wsl.hint")}</p>
						<div className="flex flex-col gap-1">
							<Label htmlFor="wsl-host-label">{t("settings.connections.add.wsl.label")}</Label>
							<Input id="wsl-host-label" value={wsl.label} onChange={(event) => setWsl((current) => ({ ...current, label: event.target.value }))} />
						</div>
						<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
							<div className="flex min-w-0 flex-col gap-1">
								<Label htmlFor="wsl-host-distro">{t("settings.connections.add.wsl.distro")}</Label>
								<Input id="wsl-host-distro" placeholder="Ubuntu" value={wsl.distro} onChange={(event) => setWsl((current) => ({ ...current, distro: event.target.value }))} />
							</div>
							<div className="flex min-w-0 flex-col gap-1">
								<Label htmlFor="wsl-host-user">{t("settings.connections.add.wsl.user")}</Label>
								<Input id="wsl-host-user" autoComplete="off" spellCheck={false} placeholder="dev" value={wsl.user} onChange={(event) => setWsl((current) => ({ ...current, user: event.target.value }))} />
							</div>
						</div>
						{wslError !== null ? <p className="text-label text-destructive">{wslError}</p> : null}
					</div>
				) : (
					<>
						<div className="flex flex-col gap-4">
							<div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
								<div className="flex min-w-0 flex-col gap-1">
									<Label htmlFor="remote-host-name">{t("settings.connections.add.hostName")}</Label>
									<Input id="remote-host-name" placeholder="host.com" value={form.hostName} onChange={(event) => setForm((current) => ({ ...current, hostName: event.target.value }))} />
								</div>
								<div className="flex min-w-0 flex-col gap-1">
									<Label htmlFor="remote-host-port">{t("settings.connections.add.port")}</Label>
									<Input id="remote-host-port" inputMode="numeric" placeholder="22" value={form.port} onChange={(event) => setForm((current) => ({ ...current, port: event.target.value }))} />
								</div>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="remote-host-user">{t("settings.connections.add.user")}</Label>
								<Input id="remote-host-user" autoComplete="off" spellCheck={false} placeholder={t("settings.connections.add.userPlaceholder")} value={form.user} onChange={(event) => setForm((current) => ({ ...current, user: event.target.value }))} />
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="remote-host-label">{t("settings.connections.add.label")}</Label>
								<Input id="remote-host-label" value={form.label} onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))} />
							</div>
							<div className="flex flex-wrap items-center gap-3">
								<span className="text-label text-muted-foreground">{t("settings.connections.add.authLabel")}</span>
								<div role="group" aria-label={t("settings.connections.add.authLabel")} className="flex w-fit overflow-hidden rounded-lg border border-input">
									<button
										type="button"
										aria-pressed={form.auth === "agent"}
										className={cn("inline-flex min-h-8 items-center px-3 text-body", form.auth === "agent" ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-bg-hover")}
										onClick={() => setForm((current) => ({ ...current, auth: "agent", identityFile: "" }))}
									>
										{t("settings.connections.add.auth.agent")}
									</button>
									<button
										type="button"
										aria-pressed={form.auth === "key"}
										className={cn("inline-flex min-h-8 items-center border-l border-input px-3 text-body", form.auth === "key" ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-bg-hover")}
										onClick={() => setForm((current) => ({ ...current, auth: "key" }))}
									>
										{t("settings.connections.add.auth.key")}
									</button>
									<button
										type="button"
										aria-pressed={form.auth === "password"}
										className={cn("inline-flex min-h-8 items-center border-l border-input px-3 text-body", form.auth === "password" ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-bg-hover")}
										onClick={() => setForm((current) => ({ ...current, auth: "password", identityFile: "" }))}
									>
										{t("settings.connections.add.auth.password")}
									</button>
								</div>
							</div>
							{form.auth === "password" ? (
								<div className="flex flex-col gap-1">
									<Label htmlFor="remote-host-password">{t("settings.connections.add.password")}</Label>
									<div className="relative">
										<Input id="remote-host-password" type={showPassword ? "text" : "password"} autoComplete="off" spellCheck={false} className="pr-10" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} />
										<button
											type="button"
											aria-label={t(showPassword ? "settings.connections.add.hidePassword" : "settings.connections.add.showPassword")}
											aria-pressed={showPassword}
											className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-bg-hover hover:text-foreground"
											onClick={() => setShowPassword((current) => !current)}
										>
											{showPassword ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
										</button>
									</div>
								</div>
							) : null}
							{form.auth === "key" ? (
								<div className="flex flex-col gap-3">
									<div className="flex flex-col gap-1">
										<Label htmlFor="remote-host-identity">{t("settings.connections.add.identityFile")}</Label>
										<Popover open={identityOpen} onOpenChange={setIdentityOpen}>
											<PopoverAnchor asChild>
												<div className="relative">
													<Input
														id="remote-host-identity"
														autoComplete="off"
														spellCheck={false}
														placeholder={t("settings.connections.add.identityFilePlaceholder")}
														className="pr-16"
														value={form.identityFile}
														onChange={(event) => setForm((current) => ({ ...current, identityFile: event.target.value }))}
														onClick={() => {
															if (identitySuggestions.length > 0) setIdentityOpen(true);
														}}
													/>
													{identitySuggestions.length > 0 ? (
														<button
															type="button"
															aria-label={t("settings.connections.add.identitySuggestions")}
															aria-expanded={identityOpen}
															className="absolute right-8 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-bg-hover hover:text-foreground"
															onClick={() => setIdentityOpen((current) => !current)}
														>
															<ChevronDown className={cn("size-4 transition-transform", identityOpen && "rotate-180")} aria-hidden="true" />
														</button>
													) : null}
													<button
														type="button"
														aria-label={t("settings.connections.add.identityBrowse")}
														title={t("settings.connections.add.identityBrowse")}
														className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-bg-hover hover:text-foreground"
														onClick={() => {
															void (async () => {
																const picked = await desktopApi.remoteHosts.pickIdentityFile();
																if (picked.ok) setForm((current) => ({ ...current, identityFile: picked.path }));
															})();
														}}
													>
														<FolderOpen className="size-4" aria-hidden="true" />
													</button>
												</div>
											</PopoverAnchor>
											{/* 扫描到的私钥放进下拉里：默认不占版面，点开才出现。 */}
											<PopoverContent align="start" sideOffset={4} className="w-[26rem] max-w-[var(--radix-popover-content-available-width)] p-1">
												{/* scroll-ok: bounded 私钥候选，条目有限且由 max-h 收束 */}
												<ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
													{identitySuggestions.map((path) => (
														<li key={path}>
															<button
																type="button"
																className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-label text-muted-foreground outline-none transition-colors hover:bg-bg-hover hover:text-foreground focus-visible:bg-bg-hover", form.identityFile === path && "bg-bg-hover text-foreground")}
																title={path}
																onClick={() => {
																	setForm((current) => ({ ...current, identityFile: path }));
																	setIdentityOpen(false);
																}}
															>
																<FileCode className="size-3.5 shrink-0" aria-hidden="true" />
																<span className="truncate">{path}</span>
															</button>
														</li>
													))}
												</ul>
											</PopoverContent>
										</Popover>
									</div>
									<div className="flex flex-col gap-1">
										<Label htmlFor="remote-host-passphrase">{t("settings.connections.add.passphrase")}</Label>
										<div className="relative">
											<Input
												id="remote-host-passphrase"
												type={showSecret ? "text" : "password"}
												autoComplete="off"
												spellCheck={false}
												placeholder={t("settings.connections.add.passphrasePlaceholder")}
												className="pr-10"
												value={form.passphrase}
												onChange={(event) => setForm((current) => ({ ...current, passphrase: event.target.value }))}
											/>
											<button
												type="button"
												aria-label={t(showSecret ? "settings.connections.add.hideSecret" : "settings.connections.add.showSecret")}
												aria-pressed={showSecret}
												className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-bg-hover hover:text-foreground"
												onClick={() => setShowSecret((current) => !current)}
											>
												{showSecret ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
											</button>
										</div>
									</div>
								</div>
							) : null}
							<p className="text-label text-muted-foreground">{t("settings.connections.add.credentialsHint")}</p>
						</div>

						{testResult !== null ? <p className={cn("text-label", testResult.ok ? "text-muted-foreground" : "text-destructive")}>{testResult.ok ? t("settings.connections.add.testOk", { fingerprint: testResult.fingerprint }) : t("settings.connections.add.testFailed", { reason: testResult.reason })}</p> : null}
						{error !== null ? <p className="text-label text-destructive">{error}</p> : null}
					</>
				)}

				<DialogFooter className="flex-row items-center justify-between gap-2 border-t border-border-subtle pt-4 sm:justify-between">
					<span className="min-w-0 truncate text-label text-muted-foreground">{kind === "ssh" && importing ? t("settings.connections.add.importHint") : null}</span>
					<div className="flex items-center gap-2">
						<Button variant="ghost" onClick={props.onClose}>
							{t("common.cancel")}
						</Button>
						{kind === "ssh" ? (
							<>
								<Button variant="outline" disabled={busy || testing || form.auth === "password"} title={form.auth === "password" ? t("settings.connections.add.testPasswordUnsupported") : undefined} onClick={() => void testConnection()}>
									{testing ? t("settings.connections.add.testing") : t("settings.connections.add.test")}
								</Button>
								<Button disabled={busy || testing} onClick={() => void submit()}>
									{editing === undefined ? t("settings.connections.add.submitConnect") : t("common.save")}
								</Button>
							</>
						) : (
							<Button disabled={wslBusy} onClick={() => void submitWsl()}>
								{t("settings.connections.add.wsl.submit")}
							</Button>
						)}
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
