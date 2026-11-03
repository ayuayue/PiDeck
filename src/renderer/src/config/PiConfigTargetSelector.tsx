import { Cloud, Monitor, SquareTerminal } from "lucide-react";
import type { PiConfigTarget } from "../../../shared/piConfig";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "../components/ui-shadcn/select";
import { t } from "../i18n";
import { configTargetBarVisible, wslTargetHostOf, type PiConfigTargetHost } from "./piConfigTargetModel";

export type { PiConfigTargetHost, WslConfigTargetHost } from "./piConfigTargetModel";

/**
 * Local / verified-ssh / WSL-profile target selector for the models/settings configuration surfaces.
 *
 * 三组值分别是 `local`、`ssh:<hostId>`、`wsl:<profileId>`：id 命名空间由前缀区分，同一个 id 在两组里
 * 不会互相覆盖。选择器只负责拼 target 值；是否需要丢弃未保存草稿由 owner（ConfigModal）决定。
 *
 * 只有本机一个可选目标时整条不渲染（见 configTargetBarVisible）：没有可切换的东西，目标标签与
 * 「暂无已验证的 SSH 主机」只是占掉页首一行噪音。
 */
export function PiConfigTargetSelector(props: { target: PiConfigTarget; hosts: PiConfigTargetHost[]; disabled?: boolean; onChange: (target: PiConfigTarget) => void }) {
	const target = props.target;
	if (!configTargetBarVisible(target, props.hosts)) return null;
	const value = target.kind === "local" ? "local" : target.kind + ":" + target.hostId;
	const sshHost = target.kind === "ssh" ? props.hosts.find((host) => host.kind === "ssh" && host.id === target.hostId) : undefined;
	const wslHost = wslTargetHostOf(props.hosts, target);
	const sshHosts = props.hosts.filter((host) => host.kind === "ssh");
	const wslHosts = props.hosts.filter((host) => host.kind === "wsl");
	const targetLabel = target.kind === "local" ? t("config.target.local") : (sshHost?.label ?? wslHost?.label ?? t("config.target.unknownHost"));
	const currentTarget = (
		<span className="flex min-w-0 items-center gap-1.5">
			{target.kind === "local" ? <Monitor className="size-3.5 shrink-0" aria-hidden="true" /> : target.kind === "ssh" ? <Cloud className="size-3.5 shrink-0" aria-hidden="true" /> : <SquareTerminal className="size-3.5 shrink-0" aria-hidden="true" />}
			<span className="truncate">{targetLabel}</span>
		</span>
	);
	return (
		<div className="config-target-bar flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2" data-testid="config-target-bar">
			<span className="text-micro font-medium text-muted-foreground">{t("config.target.label")}</span>
			<Select
				value={value}
				disabled={props.disabled}
				onValueChange={(next) => {
					if (next === "local") {
						props.onChange({ kind: "local" });
						return;
					}
					if (next.startsWith("ssh:")) props.onChange({ kind: "ssh", hostId: next.slice(4) });
					if (next.startsWith("wsl:")) props.onChange({ kind: "wsl", hostId: next.slice(4) });
				}}
			>
				<SelectTrigger className="h-8 w-auto min-w-[10rem] max-w-full gap-1.5 px-2.5 text-control" data-testid="config-target-selector" aria-label={t("config.target.label")}>
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
							{sshHosts.map((host) => (
								<SelectItem key={"ssh:" + host.id} value={"ssh:" + host.id} data-testid={"config-target-ssh-" + host.id}>
									<span className="flex min-w-0 items-center gap-1.5">
										<Cloud className="size-3.5 shrink-0" aria-hidden="true" />
										<span className="truncate">{host.label}</span>
										<span className="truncate font-mono text-micro text-muted-foreground">{host.sshHost}</span>
									</span>
								</SelectItem>
							))}
						</SelectGroup>
					) : null}
					{wslHosts.length > 0 ? (
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
						</SelectGroup>
					) : null}
				</SelectContent>
			</Select>
			{target.kind === "ssh" ? (
				<span className="ml-auto flex items-center gap-1.5 text-micro text-muted-foreground" data-testid="config-target-remote-hint">
					<Cloud className="size-3.5" aria-hidden="true" />
					{t("config.target.remoteHint")}
				</span>
			) : null}
			{target.kind === "wsl" ? (
				<span className="ml-auto flex items-center gap-1.5 text-micro text-muted-foreground" data-testid="config-target-wsl-hint">
					<SquareTerminal className="size-3.5" aria-hidden="true" />
					{t("config.target.wslHint")}
				</span>
			) : null}
		</div>
	);
}
