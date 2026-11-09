import { useAtomValue } from "jotai";
import { useState } from "react";
import { remoteProjectTrustEntriesSortedAtom, remoteProjectTrustStateAtom, type RemoteProjectTrustTarget } from "../../../atoms/remote-trust-atoms";
import { useRemoteProjectTrust } from "../../../hooks/useRemoteProjectTrust";
import { formatI18nDateTime, t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { SettingsSection } from "./SettingsStorageTab";

/**
 * 设置 → 连接 → 远端信任：决策清单与撤销（P4.4b）。
 *
 * 这是 trust 的**审计入口**：一行 = 一条决策（主机 label + 远端项目根 + 状态 + 决定时间 + 撤销）。
 * 三条边界：
 * - 只显示「主机 label / 项目根 / 决策 / 状态」——endpoint 摘要、指纹、known_hosts 摘要都不出现在渲染层
 *   （`RemoteProjectTrustEntry` 结构上就装不下它们，见 `shared/types/remoteTrust.ts`）。
 * - 状态以**PiDeck 自己的决策存储**为权威（远端 pi 没有 `project_trust` 事件可消费）：`已作废` 表示
 *   「决策时的 endpoint 材料与当前主机不一致」（换机 / 指纹变 / 用户或端口变）⇒ 下一次 spawn 不会带 flag。
 * - 撤销下一次启动立即生效（主进程每轮 spawn 现读决策），不要求重启应用。
 */
export function RemoteProjectTrustPanel() {
	const trust = useRemoteProjectTrust();
	const listState = useAtomValue(remoteProjectTrustStateAtom);
	const entries = useAtomValue(remoteProjectTrustEntriesSortedAtom);
	const [busyKey, setBusyKey] = useState<string | null>(null);
	const [errorCode, setErrorCode] = useState<string | null>(null);

	const keyOf = (target: RemoteProjectTrustTarget) => `${target.hostId}\n${target.remoteRoot}`;
	// 没有决策时整段不出现：空清单没有可操作内容，留着只会把「连接」页拉长。
	if (listState.status !== "error" && entries.length === 0) return null;

	const revoke = (target: RemoteProjectTrustTarget) => {
		setBusyKey(keyOf(target));
		setErrorCode(null);
		void (async () => {
			const result = await trust.revoke(target);
			if (!result.ok) setErrorCode(result.code);
			setBusyKey(null);
		})();
	};

	return (
		<SettingsSection title={t("settings.remoteTrust.title")} description={t("settings.remoteTrust.hint")}>
			<div className="flex flex-col gap-2">
				{listState.status === "error" ? (
					// 能力下线是稳定状态，不是错误；其余都按「读不出来」如实说。
					<p className="px-1 text-body text-muted-foreground">{listState.code === "REMOTE_FEATURE_DISABLED" ? t("settings.remoteTrust.disabled") : t("settings.remoteTrust.listUnavailable")}</p>
				) : null}
				{listState.status !== "error" && entries.length === 0 ? <p className="px-1 py-3 text-body text-muted-foreground">{t("settings.remoteTrust.empty")}</p> : null}
				{entries.map((entry) => {
					const target = { hostId: entry.hostId, remoteRoot: entry.canonicalRoot };
					const busy = busyKey === keyOf(target);
					return (
						<div key={`${entry.hostId}:${entry.canonicalRoot}`} className="flex items-center gap-3 rounded-lg border border-border-subtle px-3 py-2">
							<div className="flex min-w-0 flex-1 flex-col">
								<strong className="truncate text-body font-semibold text-foreground">{entry.hostLabel}</strong>
								{/* 项目根是判定对象，必须原样可见（等宽 + 可选中：用户要能确认信任的是哪个目录）。 */}
								<span className="select-all truncate font-mono text-label text-muted-foreground">{entry.canonicalRoot}</span>
								<span className="truncate text-label text-muted-foreground">
									{t(entry.decision === "approve" ? "settings.remoteTrust.state.approved" : "settings.remoteTrust.state.denied")} · {formatI18nDateTime(entry.decidedAt)}
								</span>
								{entry.status === "stale" ? <span className="truncate text-label text-warning">{t("settings.remoteTrust.staleReason.endpoint-changed")}</span> : null}
							</div>
							<Button variant="ghost" size="sm" disabled={busy} onClick={() => revoke(target)}>
								{t("settings.remoteTrust.revoke")}
							</Button>
						</div>
					);
				})}
				{errorCode !== null ? <p className="px-1 text-label text-warning">{t("settings.remoteTrust.actionFailed", { code: errorCode })}</p> : null}
				<div className="flex items-center gap-2 pt-1">
					<Button variant="ghost" size="sm" onClick={() => void trust.refresh()}>
						{t("settings.connections.refresh")}
					</Button>
				</div>
			</div>
		</SettingsSection>
	);
}
