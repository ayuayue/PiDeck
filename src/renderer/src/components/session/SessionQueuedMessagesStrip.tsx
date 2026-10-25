import { useAtomValue } from "jotai";
import { useCallback, useRef, useState } from "react";
import { Clock, X } from "lucide-react";
import { sessionRuntimeBySessionIdAtomFamily } from "../../atoms";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { Button } from "../ui-shadcn/button";
import { ComposerWidgetFrame } from "./ComposerWidgetLayout";

/**
 * composer 上方的 DSH host 侧排队消息条（inbox projection）。
 *
 * 与本地排队面板（QueuedPromptPanel，queuedPromptQueue 的客户端暂存）是互补关系：
 * 这里展示的是**已经送达 host、因运行中回合而滞留 inbox** 的消息——waitForIdle
 * 判定与 host 真实状态之间的竞态窗口内发生，此前完全无感知。数据源
 * `AgentRuntimeState.queuedMessages`（DSH_PROJECTION_KEYS 的 inbox 投影，空数组
 * = 无排队），行内操作取消走 `session/updateQueue` remove（幂等）。
 * 无排队项时整体不渲染（「有那个显示那个」，与 todo/goal 条一致）。
 */
export function SessionQueuedMessagesStrip(props: { sessionId: string }) {
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
	const [busyId, setBusyId] = useState<string | null>(null);
	const pendingRef = useRef(false);

	const agentId = runtime?.agentId;
	const queued = runtime?.backend === "dsh" ? runtime.state?.queuedMessages : undefined;
	const items = queued && queued.length > 0 ? queued : undefined;

	const cancel = useCallback(
		async (itemId: string) => {
			// 逐行 pending：同一时刻只允许一个取消在飞，防连点产生重复 RPC。
			if (pendingRef.current || !agentId) return;
			pendingRef.current = true;
			setBusyId(itemId);
			try {
				// 投影帧会随之清掉该行；queue-item-not-found 已在主进程侧幂等化。
				await desktopApi.sessions.cancelDshQueuedMessage(agentId, itemId);
			} catch (error) {
				showNotice(error instanceof Error ? error.message : String(error), 4000);
			} finally {
				pendingRef.current = false;
				setBusyId(null);
			}
		},
		[agentId],
	);

	if (!items || !agentId) return null;

	return (
		<ComposerWidgetFrame data-testid="session-queued-messages-strip" aria-label={t("sessionQueue.aria")}>
			<div className="flex h-9 w-full shrink-0 items-center gap-2.5 px-3">
				<Clock size={14} aria-hidden="true" className="shrink-0 text-text-tertiary" />
				<span className="shrink-0 text-control font-medium leading-6 text-foreground">{t("sessionQueue.title")}</span>
				<span className="shrink-0 rounded-full bg-bg-active px-2 text-micro leading-5 text-text-tertiary">{items.length}</span>
			</div>
			{/* 限高滚动列表：行必须 shrink-0——overflow-hidden 行在 flex 列里 min-height
			    被清零会触发整体压扁（见 AGENTS.md 待办条排版事故），先例 SessionTodoStrip。 */}
			<ul className="max-h-44 overflow-y-auto">
				{items.map((item) => (
					<li key={item.id} className="flex shrink-0 items-center gap-2.5 px-3 py-1.5">
						<span className="shrink-0 rounded bg-bg-active px-1.5 text-micro leading-5 text-text-tertiary">{item.target === "next-turn" ? t("sessionQueue.targetNextTurn") : t("sessionQueue.targetNextStep")}</span>
						<span className="min-w-0 flex-1 truncate text-control leading-5 text-text-secondary" title={item.text}>
							{item.text || t("sessionQueue.emptyText")}
						</span>
						<Button
							variant="ghost"
							size="icon-xs"
							className="size-7 shrink-0 rounded-full text-text-tertiary hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
							aria-label={t("sessionQueue.cancel")}
							title={t("sessionQueue.cancel")}
							disabled={busyId === item.id}
							onClick={() => {
								void cancel(item.id);
							}}
						>
							<X size={14} aria-hidden="true" />
						</Button>
					</li>
				))}
			</ul>
		</ComposerWidgetFrame>
	);
}
