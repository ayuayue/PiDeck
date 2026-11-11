import { useEffect, useRef, useState } from "react";
import { ChevronDown, Cloud, LoaderCircle, Monitor, RefreshCw, SquareTerminal } from "lucide-react";
import type { PiConfigTarget } from "../../../shared/piConfig";
import { Button } from "../components/ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui-shadcn/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui-shadcn/dropdown-menu";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { t } from "../i18n";
import { cn } from "../lib/utils";
import { REMOTE_HOST_TONE_DOT_CLASS, type RemoteHostConnectionTone } from "../utils/remoteHostIdentity";
import { DshLogo, PiLogo } from "../components/session/SessionSourceBadge";
import { configTargetKey, environmentScopeHintKey } from "./configEnvironmentModel";
import { configTargetHostLabel, samePiConfigTarget, wslTargetHostOf, type PiConfigTargetHost } from "./piConfigTargetModel";
import { remoteHostTone, type RemoteHostConnectionOutcome } from "./remoteHostConnectionModel";
import { useRemoteHostConnection } from "./useRemoteHostConnection";

/**
 * 顶层「Pi 配置管理」分页 + 环境下拉（本次重构的唯一环境切换点）。
 *
 * 设计约束：
 * - 环境是整页的作用域，不是一个 tab 内的表单字段：下拉挂在 Pi 分页上，选择后整个 Pi 面板按该环境重载；
 * - 每页不再各自渲染目标选择器（原先 models/settings/资源三页各一份），避免「这页切了、那页没切」；
 * - 连接状态与密码补录只在 Pi 面板内的状态条里画（见 ConfigEnvironmentStatus），下拉只负责选择；
 * - 下拉项只来自已校验未禁用的 SSH 主机与全部 WSL 档案，两边失败时仍保留「本机」回退。
 */

/** 菜单/触发器里的连接状态点：连接中用转圈（黄点是会话「Agent 在跑」的既有语义），其余复用侧栏配色。 */
export function ConnectionGlyph(props: { tone: RemoteHostConnectionTone; className?: string }) {
	if (props.tone === "connecting") return <LoaderCircle aria-hidden="true" className={cn("size-3.5 shrink-0 animate-pideck-spin text-warning", props.className)} />;
	return <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", REMOTE_HOST_TONE_DOT_CLASS[props.tone], props.className)} />;
}

/** 环境条右侧的一句话连接状态：连接中 / 已连接 / 稳定码 + 重试。 */
function ConnectionStatus(props: { tone: RemoteHostConnectionTone; errorCode?: string; hostLabel: string; onRetry: () => void }) {
	if (props.tone === "connecting") {
		return (
			<span role="status" aria-live="polite" className="flex min-w-0 items-center gap-1.5 text-micro text-muted-foreground" data-testid="config-target-remote-hint" data-tone="connecting">
				<ConnectionGlyph tone="connecting" />
				<span className="truncate animate-pulse">{t("config.target.connecting", { host: props.hostLabel })}</span>
			</span>
		);
	}
	return (
		<span role="status" aria-live="polite" className="flex min-w-0 items-center gap-1.5 text-micro text-muted-foreground" data-testid="config-target-remote-hint" data-tone={props.tone} title={t("config.target.remoteHint")}>
			<ConnectionGlyph tone={props.tone} />
			{props.tone === "error" ? <span className="truncate text-danger">{t("settings.connections.connectFailed", { code: props.errorCode ?? "REMOTE_CONNECTION_FAILED" })}</span> : props.tone === "online" ? <span className="truncate">{t("sidebar.remoteProject.connection.online")}</span> : <span className="truncate">{t("sidebar.remoteProject.connection.offline")}</span>}
			{props.tone === "online" ? null : (
				<Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 gap-1 px-1.5 text-micro" data-testid="config-target-reconnect" onClick={props.onRetry}>
					<RefreshCw className="size-3" aria-hidden="true" />
					{t("config.target.retryConnect")}
				</Button>
			)}
		</span>
	);
}

/** 环境图标：本机 / SSH / WSL 三态；连接中的 SSH 用转圈代替静态图标。 */
function EnvironmentIcon(props: { target: PiConfigTarget; tone?: RemoteHostConnectionTone; className?: string }) {
	if (props.target.kind === "local") return <Monitor className={cn("size-3.5 shrink-0", props.className)} aria-hidden="true" />;
	if (props.target.kind === "wsl") return <SquareTerminal className={cn("size-3.5 shrink-0", props.className)} aria-hidden="true" />;
	if (props.tone === "connecting") return <LoaderCircle className={cn("size-3.5 shrink-0 animate-pideck-spin text-warning", props.className)} aria-hidden="true" />;
	return <Cloud className={cn("size-3.5 shrink-0", props.className)} aria-hidden="true" />;
}

/**
 * 顶层分页条：Pi（带环境下拉）+ DSH。
 *
 * 为什么不再用 Radix TabsTrigger 包住 Pi：下拉的触发按钮不能嵌在 <button> 里（嵌套按钮是非法 HTML，
 * 会把下拉点击变成切换分页）。这里用显式的 role=tablist/tab + aria-selected 保持同一语义，
 * 内容区仍由调用方按 pane 挂载（两页都常驻，切换不丢草稿，与旧 forceMount 语义一致）。
 */
export function ConfigBackendSwitch(props: {
	pane: "pi" | "dsh";
	showDsh: boolean;
	embedded?: boolean;
	piDirty: boolean;
	dshDirty: boolean;
	target: PiConfigTarget;
	hosts: readonly PiConfigTargetHost[];
	disabled?: boolean;
	onSelectPane: (pane: "pi" | "dsh") => void;
	onSelectTarget: (target: PiConfigTarget) => void;
}) {
	const { snapshot } = useRemoteHostConnection();
	const target = props.target;
	const sshTargetId = target.kind === "ssh" ? target.hostId : "";
	const tone = sshTargetId.length > 0 ? remoteHostTone(snapshot, sshTargetId) : "offline";
	const label = configTargetHostLabel(target, props.hosts, t("config.target.local"), t("config.target.unknownHost"));
	const sshHosts = props.hosts.filter((host) => host.kind === "ssh");
	const wslHosts = props.hosts.filter((host) => host.kind === "wsl");
	const piActive = props.pane === "pi";
	const piTabRef = useRef<HTMLButtonElement | null>(null);
	const dshTabRef = useRef<HTMLButtonElement | null>(null);

	/**
	 * tablist 的键盘语义：左右方向键在两个分页间移动并切换（Radix TabsList 原本提供的基线行为，
	 * 这里因为 Pi 分页要嵌下拉而手写，不能把这条可访问性基础一起丢掉）。
	 */
	const onTablistKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (!props.showDsh) return;
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		const gotoDsh = event.key === "ArrowRight";
		props.onSelectPane(gotoDsh ? "dsh" : "pi");
		(gotoDsh ? dshTabRef : piTabRef).current?.focus();
	};

	const selectTarget = (next: PiConfigTarget) => {
		props.onSelectPane("pi");
		if (samePiConfigTarget(next, target)) return;
		props.onSelectTarget(next);
	};

	return (
		<div
			role="tablist"
			aria-label={t("config.title")}
			onKeyDown={onTablistKeyDown}
			className={cn("config-backend-switch flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-3", props.embedded && "h-auto justify-start border-0 px-0")}
		>
			{/* Pi 分页 = 分页按钮 + 环境下拉（split control）：左边切分页，右边选环境。 */}
			<div
				className={cn(
					"config-backend-tab-group flex min-w-0 items-center",
					// 嵌入设置窗口：与 DSH 分页同款下划线（组整体承担，caret 也落在下划线里）；
					// 独立弹窗：分段条里的白底药丸。
					props.embedded ? cn("border-b-2", piActive ? "border-primary" : "border-transparent") : cn("rounded-md border", piActive ? "border-border-subtle bg-bg-panel shadow-sm" : "border-transparent"),
				)}
				data-testid="config-backend-pi-group"
			>
				<button
					ref={piTabRef}
					type="button"
					role="tab"
					aria-selected={piActive}
					tabIndex={piActive ? 0 : -1}
					data-testid="config-backend-pi"
					onClick={() => props.onSelectPane("pi")}
					className={cn(
						"flex h-8 min-w-0 items-center gap-1.5 rounded-l-md px-2.5 text-control font-medium transition-colors",
						piActive ? "text-foreground" : "text-text-secondary hover:text-foreground",
					)}
				>
					<PiLogo className="size-3.5 shrink-0" />
					<span className="truncate">{t("config.backend.pi")}</span>
					{/* 环境标签：整页作用域必须在分页上可见，否则用户不知道正在编辑哪台机器 */}
					<span className={cn("shrink-0 rounded-sm px-1 py-0.5 text-micro font-normal", target.kind === "local" ? "text-muted-foreground" : "bg-bg-input text-foreground/80")} data-testid="config-backend-pi-environment" data-kind={target.kind}>
						{label}
					</span>
					{props.piDirty ? <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" /> : null}
				</button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							aria-label={t("config.env.switch")}
							title={t("config.env.switch")}
							data-testid="config-env-trigger"
							data-kind={target.kind}
							data-tone={target.kind === "ssh" ? tone : undefined}
							disabled={props.disabled}
							className={cn(
								"flex h-8 shrink-0 items-center justify-center rounded-r-md px-1 text-text-secondary transition-colors hover:text-foreground disabled:opacity-50",
								piActive && !props.embedded && "border-l border-border-subtle",
							)}
						>
							<ChevronDown className="size-3.5" aria-hidden="true" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="w-72" data-testid="config-env-menu">
						<DropdownMenuLabel className="text-micro font-normal text-muted-foreground">{t("config.env.menuTitle")}</DropdownMenuLabel>
						<DropdownMenuItem onSelect={() => selectTarget({ kind: "local" })} data-testid="config-env-local" data-active={target.kind === "local" ? "true" : undefined} className="gap-2">
							<Monitor className="size-3.5 shrink-0" aria-hidden="true" />
							<span className="truncate">{t("config.target.local")}</span>
							{target.kind === "local" ? <span className="ml-auto text-micro text-muted-foreground">{t("config.env.currentMark")}</span> : null}
						</DropdownMenuItem>
						{sshHosts.length > 0 ? (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuLabel className="text-micro font-normal text-muted-foreground">{t("config.target.groupSsh")}</DropdownMenuLabel>
								{sshHosts.map((host) => {
									const hostTone = remoteHostTone(snapshot, host.id);
									const active = target.kind === "ssh" && target.hostId === host.id;
									return (
										<DropdownMenuItem key={"ssh:" + host.id} onSelect={() => selectTarget({ kind: "ssh", hostId: host.id })} data-testid={"config-env-ssh-" + host.id} data-active={active ? "true" : undefined} data-tone={hostTone} className="gap-2">
											<Cloud className="size-3.5 shrink-0" aria-hidden="true" />
											<span className="truncate">{host.label}</span>
											<span className="truncate font-mono text-micro text-muted-foreground">{host.sshHost}</span>
											<span className="ml-auto pl-2">
												<ConnectionGlyph tone={hostTone} />
											</span>
										</DropdownMenuItem>
									);
								})}
							</>
						) : null}
						{wslHosts.length > 0 ? (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuLabel className="text-micro font-normal text-muted-foreground">{t("config.target.wsl")}</DropdownMenuLabel>
								{wslHosts.map((host) => {
									const active = target.kind === "wsl" && target.hostId === host.id;
									return (
										<DropdownMenuItem key={"wsl:" + host.id} onSelect={() => selectTarget({ kind: "wsl", hostId: host.id })} data-testid={"config-env-wsl-" + host.id} data-active={active ? "true" : undefined} className="gap-2">
											<SquareTerminal className="size-3.5 shrink-0" aria-hidden="true" />
											<span className="truncate">{host.label}</span>
											<span className="truncate font-mono text-micro text-muted-foreground">
												{host.distro} · {host.user}
											</span>
										</DropdownMenuItem>
									);
								})}
							</>
						) : null}
						{sshHosts.length === 0 && wslHosts.length === 0 ? (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuItem disabled className="text-micro leading-relaxed text-muted-foreground">
									{t("config.env.menuEmpty")}
								</DropdownMenuItem>
							</>
						) : null}
						{/* WSL 档案一条都没有：在菜单里说明去哪里加，避免用户以为「下拉里没有=不支持」 */}
						{wslHosts.length === 0 && sshHosts.length > 0 ? (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuItem disabled className="text-micro leading-relaxed text-muted-foreground" data-testid="config-target-wsl-empty">
									{t("config.target.wslEmpty")}
								</DropdownMenuItem>
							</>
						) : null}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{props.showDsh ? (
				<button
					ref={dshTabRef}
					type="button"
					role="tab"
					aria-selected={props.pane === "dsh"}
					tabIndex={props.pane === "dsh" ? 0 : -1}
					data-testid="config-backend-dsh"
					onClick={() => props.onSelectPane("dsh")}
					className={cn(
						"flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-control font-medium transition-colors",
						props.pane === "dsh" ? "text-foreground" : "text-text-secondary hover:text-foreground",
						props.embedded ? (props.pane === "dsh" ? "border-b-2 border-primary" : "border-b-2 border-transparent") : props.pane === "dsh" ? "border border-border-subtle bg-bg-panel shadow-sm" : "border border-transparent",
					)}
				>
					<DshLogo className="size-3.5 shrink-0" />
					{t("config.backend.dsh")}
					{props.dshDirty ? <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" /> : null}
				</button>
			) : null}
		</div>
	);
}

/**
 * Pi 面板内的环境状态条：当前环境 + 连接状态/重试/密码补录 + 该环境的能力边界说明。
 *
 * 这里是**唯一**发起「选中 ssh 环境就自动连接」的地方（菜单只选择，不连接）：状态条随 Pi 面板常驻，
 * 所以选完立刻能看到「正在连接」；密码主机在连接返回 SSH_PASSWORD_REQUIRED 时就地弹一次密码框。
 */
export function ConfigEnvironmentStatus(props: { target: PiConfigTarget; hosts: readonly PiConfigTargetHost[]; disabled?: boolean }) {
	const { snapshot, ensureConnected } = useRemoteHostConnection();
	const [passwordFor, setPasswordFor] = useState<{ hostId: string; label: string } | null>(null);
	const [passwordDraft, setPasswordDraft] = useState("");
	const [passwordError, setPasswordError] = useState<string | null>(null);
	const target = props.target;
	const targetHostId = target.kind === "ssh" ? target.hostId : "";

	const requestConnection = (hostId: string, label: string, password?: string): void => {
		void ensureConnected(hostId, password).then((outcome) => {
			if (outcome.ok) {
				setPasswordFor(null);
				setPasswordDraft("");
				setPasswordError(null);
				return;
			}
			if (outcome.code === "SSH_PASSWORD_REQUIRED") {
				setPasswordError(null);
				setPasswordFor({ hostId, label });
			}
		});
	};

	// 当前环境是 SSH 且未在线时确保连接：覆盖「刚选中」与「重新打开时上次落在这台主机」两条路径。
	// disabled（正在保存）时不动连接，避免一次 SSH 往返打断保存。
	useEffect(() => {
		if (props.disabled === true || targetHostId.length === 0) return;
		const host = props.hosts.find((candidate) => candidate.kind === "ssh" && candidate.id === targetHostId);
		if (host === undefined) return;
		void ensureConnected(host.id).then((outcome: RemoteHostConnectionOutcome) => {
			if (!outcome.ok && outcome.code === "SSH_PASSWORD_REQUIRED") setPasswordFor({ hostId: host.id, label: host.label });
		});
	}, [targetHostId, props.disabled, props.hosts, ensureConnected]);

	const label = configTargetHostLabel(target, props.hosts, t("config.target.local"), t("config.target.unknownHost"));
	const wslHost = wslTargetHostOf(props.hosts, target);
	const sshTone = target.kind === "ssh" ? remoteHostTone(snapshot, target.hostId) : "offline";
	const sshError = target.kind === "ssh" ? snapshot.errors[target.hostId] : undefined;

	return (
		<div
			className="config-env-status flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 bg-bg-panel px-4 py-1.5"
			data-testid="config-environment-status"
			data-kind={target.kind}
			data-target={configTargetKey(target)}
			data-tone={target.kind === "ssh" ? sshTone : undefined}
		>
			<span className="flex min-w-0 items-center gap-1.5">
				<span className="shrink-0 text-micro text-muted-foreground">{t("config.env.current")}</span>
				<span className="flex min-w-0 items-center gap-1 text-control font-medium">
					<EnvironmentIcon target={target} tone={sshTone} />
					<span className="truncate" data-testid="config-environment-label">
						{label}
					</span>
				</span>
				{target.kind === "wsl" && wslHost ? (
					<span className="truncate font-mono text-micro text-muted-foreground">
						{wslHost.distro} · {wslHost.user}
					</span>
				) : null}
			</span>
			{target.kind === "ssh" ? <ConnectionStatus tone={sshTone} errorCode={sshError} hostLabel={label} onRetry={() => requestConnection(target.hostId, label)} /> : null}
			<span className="ml-auto flex min-w-0 items-center gap-1 text-micro text-muted-foreground" data-testid="config-env-scope" title={t(environmentScopeHintKey(target))}>
				<span className="truncate">{t(environmentScopeHintKey(target))}</span>
			</span>

			{passwordFor !== null ? (
				<Dialog
					open
					onOpenChange={(open) => {
						if (open) return;
						setPasswordFor(null);
						setPasswordDraft("");
						setPasswordError(null);
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>{t("settings.connections.password.title", { host: passwordFor.label })}</DialogTitle>
							<DialogDescription>{t("settings.connections.password.description")}</DialogDescription>
						</DialogHeader>
						<div className="flex flex-col gap-1">
							<Label htmlFor="config-env-password">{t("settings.connections.password.label")}</Label>
							<Input id="config-env-password" type="password" autoComplete="off" spellCheck={false} value={passwordDraft} onChange={(event) => setPasswordDraft(event.target.value)} />
							{passwordError !== null ? <span className="text-micro text-danger">{t("settings.connections.connectFailed", { code: passwordError })}</span> : null}
						</div>
						<DialogFooter>
							<Button
								variant="ghost"
								onClick={() => {
									setPasswordFor(null);
									setPasswordDraft("");
									setPasswordError(null);
								}}
							>
								{t("settings.connections.password.cancel")}
							</Button>
							<Button
								disabled={passwordDraft.length === 0}
								onClick={() => {
									const request = passwordFor;
									const value = passwordDraft;
									setPasswordError(null);
									void ensureConnected(request.hostId, value).then((outcome) => {
										if (outcome.ok) {
											setPasswordFor(null);
											setPasswordDraft("");
											return;
										}
										setPasswordError(outcome.code);
									});
								}}
							>
								{t("settings.connections.password.submit")}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			) : null}
		</div>
	);
}
