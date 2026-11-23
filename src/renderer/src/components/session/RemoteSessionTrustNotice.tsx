import { useAtomValue } from "jotai";
import { ShieldAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { sessionRemoteTrustStateAtomFamily, type SessionRemoteTrustState } from "../../atoms/remote-trust-atoms";
import { useRemoteProjectTrust } from "../../hooks/useRemoteProjectTrust";
import { t, type TranslationKey } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { shouldShowRemoteTrustNotice } from "./remoteTrustNoticeVisibility";

/**
 * 远端会话的 trust 决策条（Phase 4：P4.2 如实告知 → P4.4b 可决策 + 可撤销）。
 *
 * 语义（`docs/archive/remote/remote-trust-plan.md` §2 / §3）：
 * - 判定对象是「**这台主机的这个远端项目根**」的 `.pi` 资源（扩展/技能/提示词/项目设置）是否被加载，
 *   key 是 `hostId + endpoint 身份摘要 + 规范项目根`。本组件只按 `(hostId, 项目根)` 操作：
 *   endpoint 材料（指纹 / known_hosts 摘要 / trust key）**不出主进程**，界面上也永远不出现。
 * - **状态权威是 PiDeck 自己的决策存储**（主进程 `remoteProjectTrust` 段），不是 pi 事件：目标远端版本
 *   没有 `project_trust` 事件，而本机与远端 pi 版本可能不同，靠事件判断「远端 pi 实际信任了什么」
 *   既拿不到也不可信。这里回答的是可验证的问题——**下一次启动我们会传什么 flag**。
 * - **是否渲染**仍由静态标记 `remoteTrustUnhandled` 决定（远端会话才有这条提示；本机/WSL/DSH/生图会话、
 *   旧 main 的旧载荷一律不渲染），该标记与决策状态在 `sessionRemoteTrustStateAtomFamily` 里合成四态。
 * - 决策只影响**下一次 spawn**：已经跑着的远端 pi 不会因此改变（提示里写明「下次启动生效」），
 *   撤销同理（`remoteRuntimePort.prepare` 每轮现读决策）。
 *
 * 已信任或拒绝后不显示提示；未决策与作废仍常驻，设置页可以查看和撤销决定。
 */

export function RemoteSessionTrustNotice(props: { sessionId: string }) {
	const state = useAtomValue(sessionRemoteTrustStateAtomFamily(props.sessionId));
	// 标记缺失（本地/WSL 会话，或旧 main 的旧 payload）时整体不渲染——不显示，也不报错。
	// 判定留在这一层，也让非远端会话完全不进下面那条「读决策表 / 写决策」的链路。
	if (state === undefined) return null;
	return <RemoteSessionTrustNoticeBody key={props.sessionId} state={state} />;
}

/** 决策条正文：需要读清单 + 写决策，所以单开一层（非远端会话不会挂载它）。 */
function RemoteSessionTrustNoticeBody(props: { state: SessionRemoteTrustState }) {
	const { state } = props;
	const trust = useRemoteProjectTrust();
	const [busy, setBusy] = useState(false);
	const [errorCode, setErrorCode] = useState<string | null>(null);

	if (!shouldShowRemoteTrustNotice(state.kind)) return null;

	const target = state.kind === "undecided" ? state.target : { hostId: state.entry.hostId, remoteRoot: state.entry.canonicalRoot };
	const copy = COPY[state.kind];
	const run = async (action: () => Promise<{ ok: true } | { ok: false; code: string }>) => {
		setBusy(true);
		setErrorCode(null);
		const result = await action();
		if (!result.ok) setErrorCode(result.code);
		setBusy(false);
	};

	return (
		<div role="status" data-testid="remote-session-trust-notice" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-subtle bg-bg-panel px-3 py-1.5 text-caption">
			{copy.icon}
			{/* 标题与说明同一行：标题点明状态，说明给出「远端项目资源现在会不会被加载 + 决定何时生效」。 */}
			<span className="shrink-0 font-medium text-foreground">{t(copy.title)}</span>
			<span className="min-w-0 text-muted-foreground">{t(copy.hint)}</span>
			{/* 有判定对象（项目 ssh locator 可用）才给决策入口：没有对象写不出决策，给个点不通的按钮更糟。 */}
			{target !== undefined ? (
				<div className="ml-auto flex shrink-0 items-center gap-1">
					<Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => trust.decide(target, "deny"))}>
						{t("session.remoteTrust.action.deny")}
					</Button>
					<Button size="sm" disabled={busy} onClick={() => void run(() => trust.decide(target, "approve"))}>
						{t("session.remoteTrust.action.trust")}
					</Button>
					{/* 已作废的条目还要能直接清掉。 */}
					{state.kind === "stale" ? (
						<Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => trust.revoke(target))}>
							{t("session.remoteTrust.action.revoke")}
						</Button>
					) : null}
				</div>
			) : null}
			{/* 失败一律用稳定码说清（不猜原因）：既可能是门禁关闭，也可能是主机 pin 事实拿不到。 */}
			{errorCode !== null ? <span className="shrink-0 text-warning">{t("session.remoteTrust.actionFailed", { code: errorCode })}</span> : null}
		</div>
	);
}

/** 待处理状态的图标与文案。 */
const COPY: Record<"undecided" | "stale", { icon: ReactNode; title: TranslationKey; hint: TranslationKey }> = {
	undecided: {
		icon: <ShieldAlert size={12} aria-hidden="true" className="shrink-0 text-warning" />,
		title: "session.remoteTrust.title",
		hint: "session.remoteTrust.hint",
	},
	stale: {
		icon: <ShieldAlert size={12} aria-hidden="true" className="shrink-0 text-warning" />,
		title: "session.remoteTrust.stale.title",
		hint: "session.remoteTrust.stale.hint",
	},
};
