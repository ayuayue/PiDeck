import type { PiResourceTarget } from "../../../shared/piConfig";
import { t } from "../i18n";
import { configTargetBarVisible, type WslConfigTargetHost } from "./piConfigTargetModel";
import { PiConfigTargetSelector } from "./PiConfigTargetSelector";

/**
 * 资源三页的目标条：本机 / WSL 档案（复用 PiConfigTargetSelector）。
 * 非本机目标本轮只支持 list + 提示词读写，条内直接说明，避免用户以为技能/扩展的写操作会落到发行版。
 *
 * 选择器的值域是 PiConfigTarget（含 ssh），资源域只有 local/wsl：ssh 条目根本不在 hosts 里，
 * 这里再显式忽略一次（绝不把 ssh 静默落成本机，也不会把 ssh 目标传进资源池）。
 */
export function ResourceTargetBar(props: { target: PiResourceTarget; hosts: WslConfigTargetHost[]; disabled?: boolean; readOnly: boolean; onChange: (target: PiResourceTarget) => void }) {
	// 选择器自己会隐藏，但外面这层还拄着 data-testid 与只读提示；没有可切换目标且不需要提示时
	// 整条都不留（否则只会在页首留一个空 div）。
	if (!configTargetBarVisible(props.target, props.hosts) && !props.readOnly) return null;
	return (
		<div className="flex flex-col" data-testid="resource-target-bar">
			<PiConfigTargetSelector
				target={props.target}
				hosts={props.hosts}
				disabled={props.disabled}
				onChange={(next) => {
					if (next.kind === "ssh") return;
					props.onChange(next);
				}}
			/>
			{props.readOnly ? (
				<span className="pb-1 text-micro text-muted-foreground" data-testid="resource-target-readonly-hint">
					{t("config.resourceTarget.readOnlyHint")}
				</span>
			) : null}
		</div>
	);
}
