import { useEffect, useState } from "react";
import { Cloud, LoaderCircle, Monitor, RefreshCw, SquareTerminal } from "lucide-react";
import type { PiConfigTarget } from "../../../shared/piConfig";
import { Button } from "../components/ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui-shadcn/dialog";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "../components/ui-shadcn/select";
import { t } from "../i18n";
import { detectRendererPlatform } from "../lib/detectRendererPlatform";
import { cn } from "../lib/utils";
import { REMOTE_HOST_TONE_DOT_CLASS, type RemoteHostConnectionTone } from "../utils/remoteHostIdentity";
import { configTargetBarVisible, wslTargetHostOf, type PiConfigTargetHost } from "./piConfigTargetModel";
import { remoteHostTone, type RemoteHostConnectionOutcome } from "./remoteHostConnectionModel";
import { useRemoteHostConnection } from "./useRemoteHostConnection";

export type { PiConfigTargetHost, WslConfigTargetHost } from "./piConfigTargetModel";

/** 菜单/触发器里的连接状态点：连接中用转圈（黄点是会话「Agent 在跑」的既有语义），其余复用侧栏配色。 */
function ConnectionGlyph(props: { tone: RemoteHostConnectionTone; className?: string }) {
	if (props.tone === "connecting") return <LoaderCircle aria-hidden="true" className={cn("size-3.5 shrink-0 animate-pideck-spin text-warning", props.className)} />;
	return <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", REMOTE_HOST_TONE_DOT_CLASS[props.tone], props.className)} />;
}

function targetKey(target: PiConfigTarget): string {
	return target.kind === "local" ? "local" : target.kind + ":" + target.hostId;
}

/** 远端目标条右侧的一句话状态：连接中 / 已连接 / 稳定码 + 重试。 */
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

/**
 * Local / verified-ssh / WSL-profile target selector for the models/settings/resource configuration surfaces.
 *
 * 三组值分别是 `local`、`ssh:<hostId>`、`wsl:<profileId>`：id 命名空间由前缀区分，同一个 id 在两组里
 * 不会互相覆盖。选择器只负责拼 target 值；是否需要丢弃未保存草稿由 owner（ConfigModal）决定。
 *
 * 只有本机一个可选目标时整条不渲染（见 configTargetBarVisible）：没有可切换的东西，目标标签与
 * 「暂无已验证的 SSH 主机」只是占掉页首一行噪音。
 *
 * 自动连接（本批）：选中未连接的 SSH 主机、或带着 ssh 目标重新打开页面时，这里主动
 * `remoteHosts.connect`，并把「正在连接」画在目标条上；成功后远端配置面板自己读，失败才给稳定码与
 * 重试。密码主机在连接返回 SSH_PASSWORD_REQUIRED 时就地弹一次密码框——否则「自动连接」对密码认证
 * 的主机等于换了个地方报错。连接状态与去重来自 `useRemoteHostConnection`（面板共用同一份）。
 */
export function PiConfigTargetSelector(props: { target: PiConfigTarget; hosts: PiConfigTargetHost[]; disabled?: boolean; onChange: (target: PiConfigTarget) => void }) {
	const target = props.target;
	const { snapshot, ensureConnected } = useRemoteHostConnection();
	const [passwordFor, setPasswordFor] = useState<{ hostId: string; label: string } | null>(null);
	const [passwordDraft, setPasswordDraft] = useState("");
	const [passwordError, setPasswordError] = useState<string | null>(null);
	const targetHostId = target.kind === "ssh" ? target.hostId : "";

	/** 一次连接尝试的唯一收口：密码认证转成一次就地补密码，其它失败留在目标条上用稳定码 + 重试。 */
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

	// 当前目标是 SSH 且未在线时确保连接：覆盖「刚选中」与「重新打开时上次落在这台主机」两条路径。
	// disabled（正在保存）时不动连接，避免一次 SSH 往返打断保存。
	useEffect(() => {
		if (props.disabled === true || targetHostId.length === 0) return;
		const host = props.hosts.find((candidate) => candidate.kind === "ssh" && candidate.id === targetHostId);
		if (host === undefined) return;
		void ensureConnected(host.id).then((outcome: RemoteHostConnectionOutcome) => {
			if (!outcome.ok && outcome.code === "SSH_PASSWORD_REQUIRED") setPasswordFor({ hostId: host.id, label: host.label });
		});
	}, [targetHostId, props.disabled, props.hosts, ensureConnected]);

	if (!configTargetBarVisible(target, props.hosts)) return null;
	const value = targetKey(target);
	const sshHost = target.kind === "ssh" ? props.hosts.find((host) => host.kind === "ssh" && host.id === target.hostId) : undefined;
	const wslHost = wslTargetHostOf(props.hosts, target);
	const sshHosts = props.hosts.filter((host) => host.kind === "ssh");
	const wslHosts = props.hosts.filter((host) => host.kind === "wsl");
	const targetLabel = target.kind === "local" ? t("config.target.local") : (sshHost?.label ?? wslHost?.label ?? t("config.target.unknownHost"));
	const sshTone = target.kind === "ssh" ? remoteHostTone(snapshot, target.hostId) : "offline";
	const sshError = target.kind === "ssh" ? snapshot.errors[target.hostId] : undefined;
	const connecting = sshTone === "connecting";
	// WSL 在 Windows 上是本机能力；其它平台把「没有档案」说清楚就是全部可做的事。
	const windows = detectRendererPlatform(typeof navigator === "undefined" ? "" : navigator.userAgent) === "win32";

	const currentTarget = (
		<span className="flex min-w-0 items-center gap-1.5">
			{target.kind === "local" ? (
				<Monitor className="size-3.5 shrink-0" aria-hidden="true" />
			) : target.kind === "ssh" ? (
				connecting ? (
					<LoaderCircle className="size-3.5 shrink-0 animate-pideck-spin text-warning" aria-hidden="true" />
				) : (
					<Cloud className="size-3.5 shrink-0" aria-hidden="true" />
				)
			) : (
				<SquareTerminal className="size-3.5 shrink-0" aria-hidden="true" />
			)}
			<span className="truncate">{targetLabel}</span>
		</span>
	);

	return (
		<div className="config-target-bar flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="config-target-bar" data-tone={target.kind === "ssh" ? sshTone : undefined}>
			<Select
				value={value}
				disabled={props.disabled}
				onValueChange={(next) => {
					if (next === "local") {
						props.onChange({ kind: "local" });
						return;
					}
					if (next.startsWith("ssh:")) {
						props.onChange({ kind: "ssh", hostId: next.slice(4) });
						return;
					}
					if (next.startsWith("wsl:")) props.onChange({ kind: "wsl", hostId: next.slice(4) });
				}}
			>
				<SelectTrigger
					size="sm"
					className="h-8 w-auto min-w-[10rem] max-w-[min(24rem,100%)] gap-1.5 rounded-md border-border-subtle bg-bg-panel px-2.5 text-control shadow-none hover:bg-bg-hover data-[state=open]:bg-bg-hover"
					data-testid="config-target-selector"
					data-tone={target.kind === "ssh" ? sshTone : undefined}
					aria-label={t("config.target.label") + ": " + targetLabel}
				>
					{currentTarget}
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="local" data-testid="config-target-local">
						<span className="flex items-center gap-1.5">
							<Monitor className="size-3.5" aria-hidden="true" />
							{t("config.target.local")}
						</span>
					</SelectItem>
					{sshHosts.length > 0 ? (
						<SelectGroup>
							<SelectLabel>{t("config.target.groupSsh")}</SelectLabel>
							{sshHosts.map((host) => {
								const tone = remoteHostTone(snapshot, host.id);
								return (
									<SelectItem key={"ssh:" + host.id} value={"ssh:" + host.id} data-testid={"config-target-ssh-" + host.id} data-tone={tone}>
										<span className="flex min-w-0 items-center gap-1.5">
											<Cloud className="size-3.5 shrink-0" aria-hidden="true" />
											<span className="truncate">{host.label}</span>
											<span className="truncate font-mono text-micro text-muted-foreground">{host.sshHost}</span>
											<span className="ml-auto pl-2">
												<ConnectionGlyph tone={tone} />
											</span>
										</span>
									</SelectItem>
								);
							})}
						</SelectGroup>
					) : null}
					{wslHosts.length > 0 || windows ? (
						<SelectGroup>
							<SelectLabel>{t("config.target.wsl")}</SelectLabel>
							{wslHosts.map((host) => (
								<SelectItem key={"wsl:" + host.id} value={"wsl:" + host.id} data-testid={"config-target-wsl-" + host.id}>
									<span className="flex min-w-0 items-center gap-1.5">
										<SquareTerminal className="size-3.5 shrink-0" aria-hidden="true" />
										<span className="truncate">{host.label}</span>
										<span className="truncate font-mono text-micro text-muted-foreground">
											{host.distro} · {host.user}
										</span>
									</span>
								</SelectItem>
							))}
							{/* 没有档案时也保留这一组：下拉是用户找「本地还是远端」的地方，空着等于说 WSL 不支持。 */}
							{wslHosts.length === 0 ? (
								<div className="px-2 py-1.5 text-micro leading-relaxed text-muted-foreground" data-testid="config-target-wsl-empty">
									{t("config.target.wslEmpty")}
								</div>
							) : null}
						</SelectGroup>
					) : null}
				</SelectContent>
			</Select>

			{target.kind === "ssh" ? (
				<span className="ml-auto min-w-0">
					<ConnectionStatus tone={sshTone} errorCode={sshError} hostLabel={targetLabel} onRetry={() => requestConnection(target.hostId, targetLabel)} />
				</span>
			) : null}
			{target.kind === "wsl" ? (
				<span className="ml-auto flex min-w-0 items-center gap-1.5 text-micro text-muted-foreground" data-testid="config-target-wsl-hint">
					<SquareTerminal className="size-3.5" aria-hidden="true" />
					{t("config.target.wslHint")}
				</span>
			) : null}

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
							<Label htmlFor="config-target-password">{t("settings.connections.password.label")}</Label>
							<Input id="config-target-password" type="password" autoComplete="off" spellCheck={false} value={passwordDraft} onChange={(event) => setPasswordDraft(event.target.value)} />
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
