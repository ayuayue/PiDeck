import { useCallback, useEffect, useState } from "react";
import { MousePointer2 } from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { ApprovalCard } from "../ui-shadcn/approval-card";
import { APPROVAL_TTL_MS, dequeueApproval, enqueueApproval, expireApprovals, peekApproval } from "../../utils/cuaApprovalQueue";

const ACTION_LABEL_KEYS: Record<string, TranslationKey> = {
	click: "cua.action.click",
	type: "cua.action.type",
	scroll: "cua.action.scroll",
	capture: "cua.action.capture",
	list_windows: "cua.action.list_windows",
	get_state: "cua.action.get_state",
	browser_click: "cua.action.browser_click",
	browser_type: "cua.action.browser_type",
	browser_press_key: "cua.action.browser_press_key",
	browser_navigate: "cua.action.browser_navigate",
	browser_scroll: "cua.action.browser_scroll",
};

/**
 * 只读动作：CUA 的取屏/列窗/查状态，以及浏览器 Agent 的读取类动作（快照/查找/等待/截图）。
 *
 * 主进程按动作类型决定是否发起审批，只读动作本不该走到这里；渲染层再兜一道，
 * 万一路径变化把只读动作送进审批队列，也能直接放行而不是卡住整条 FIFO。
 */
const READONLY_ACTIONS = new Set(["capture", "list_windows", "get_state", "browser_state", "browser_snapshot", "browser_find", "browser_wait_for", "browser_screenshot"]);

export type CuaApprovalPayload = {
	requestId: string;
	action: string;
	sessionId: string;
	agentId?: string;
	runtimeGeneration?: number;
	detail: unknown;
	timestampMs: number;
};

export function CuaApprovalDialog(props: { request: CuaApprovalPayload | null; pendingCount?: number; responding: boolean; open: boolean; onOpenChange: (open: boolean) => void; onRespond: (allowed: boolean) => void; onCancel: () => void }) {
	const { request } = props;

	const formatDetail = useCallback((detail: unknown): string => {
		if (detail == null) return "";
		if (typeof detail === "string") return detail;
		try {
			return JSON.stringify(detail, null, 2);
		} catch {
			return String(detail);
		}
	}, []);

	if (!request) return null;

	const actionKey = ACTION_LABEL_KEYS[request.action];
	const actionLabel = actionKey ? t(actionKey) : request.action;
	const isReadonly = READONLY_ACTIONS.has(request.action);

	// Read-only actions should never trigger approval, but if they do, auto-allow.
	if (isReadonly) {
		return null;
	}

	const pendingCount = props.pendingCount ?? 1;
	const description = pendingCount > 1 ? `${actionLabel} · ${t("cua.approval.waiting")} · ${t("cua.approval.pending")} ${pendingCount}` : `${actionLabel} · ${t("cua.approval.waiting")}`;

	return (
		// 根级浮层：CUA 审批必须固定定位（同 AskPanelOverlay 的 fixed z-50 约定）。
		// ApprovalCard 本体是 position:relative 的内联卡片；若直接挂在 #root 下、排在 100vh 的
		// .wechat-shell 之后，在 body{overflow:hidden} 下会被排到视口外而永远不可见。
		<div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
			<div className="pointer-events-auto w-full max-w-[560px]">
				<ApprovalCard open={props.open} onOpenChange={props.onOpenChange} title={t("cua.approval.title")} description={description} status={t("cua.approval.waiting")} statusTone="active" onCancel={props.onCancel} cancelDisabled={props.responding} cancelLabel={t("cua.approval.close")} className="w-full">
					<div className="flex flex-col gap-2">
						{/* 操作类型徽标 */}
						<div className="flex flex-wrap items-center gap-1.5">
							<span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-muted px-2 py-0.5 text-micro font-medium text-text-secondary">
								<MousePointer2 size={12} className="shrink-0 text-[var(--color-warning)]" aria-hidden="true" />
								<span className="shrink-0">{t("cua.approval.action")}</span>
								<span className="font-semibold text-text-primary">{actionLabel}</span>
							</span>
							<span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-muted px-2 py-0.5 text-micro font-medium text-text-secondary">
								<span className="shrink-0">{t("cua.approval.session")}</span>
								<span className="font-mono text-text-primary">{request.sessionId.slice(0, 8)}</span>
							</span>
							{request.agentId && (
								<span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-muted px-2 py-0.5 text-micro font-medium text-text-secondary">
									<span className="shrink-0">{t("cua.approval.agent")}</span>
									<span className="font-mono text-text-primary">{request.agentId}</span>
								</span>
							)}
							{typeof request.runtimeGeneration === "number" && (
								<span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-muted px-2 py-0.5 text-micro font-medium text-text-secondary">
									<span className="shrink-0">{t("cua.approval.generation")}</span>
									<span className="font-mono text-text-primary">{request.runtimeGeneration}</span>
								</span>
							)}
						</div>

						{/* 详情区 */}
						<div className="rounded-md border border-border-subtle bg-bg-muted px-2.5 py-2">
							<div className="mb-1 text-micro font-semibold text-text-tertiary">{t("cua.approval.detail")}</div>
							<pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-micro leading-relaxed text-text-primary">{formatDetail(request.detail)}</pre>
						</div>

						{/* 允许/拒绝 */}
						<div className="flex gap-2">
							<Button variant="default" className="h-8 px-3" disabled={props.responding} title={t("cua.approval.allowHint")} onClick={() => props.onRespond(true)}>
								{t("cua.approval.allow")}
							</Button>
							<Button variant="outline" className="h-8 px-3" disabled={props.responding} title={t("cua.approval.denyHint")} onClick={() => props.onRespond(false)}>
								{t("cua.approval.deny")}
							</Button>
						</div>
					</div>
				</ApprovalCard>
			</div>
		</div>
	);
}

/**
 * Hook that subscribes to CUA approval requests from the main process
 * and manages the dialog state.
 *
 * 队列化：主进程可能背靠背发多个审批（如 agent 批量操作）。先前实现只保存
 * 一条 pendingRequest，新请求直接覆盖旧请求，被覆盖者只剩 30s 超时兜底，
 * 用户永远看不到。现改为 FIFO 队列（队首呈现、响应后出队），纯策略见
 * utils/cuaApprovalQueue.ts（可单测）。
 */
export function useCuaApproval() {
	const [queue, setQueue] = useState<CuaApprovalPayload[]>([]);
	const [responding, setResponding] = useState(false);
	const request = peekApproval(queue) ?? null;

	useEffect(() => {
		const unsubscribe = window.piDesktop.cua.onApprovalRequest((payload: CuaApprovalPayload) => {
			setQueue((prev) => enqueueApproval(prev, payload));
		});
		return unsubscribe;
	}, []);

	// 主进程 30s 超时后审批已被拒绝，队列里过期条目再点「允许」只是无效操作——
	// 按队首剩余存活时间定时清理（+250ms 宽限，避免与用户正在进行的点击竞速）。
	useEffect(() => {
		if (queue.length === 0) return;
		const remaining = APPROVAL_TTL_MS - (Date.now() - queue[0].timestampMs);
		const timer = setTimeout(() => {
			setQueue((prev) => expireApprovals(prev, Date.now()));
		}, Math.max(0, remaining) + 250);
		return () => clearTimeout(timer);
	}, [queue]);

	const respond = useCallback(
		async (allowed: boolean) => {
			if (!request) return;
			setResponding(true);
			try {
				await window.piDesktop.cua.sendApprovalResponse(request.requestId, {
					allowed,
					reason: allowed ? undefined : "user_denied",
				});
			} finally {
				setResponding(false);
				setQueue((prev) => dequeueApproval(prev));
			}
		},
		[request],
	);

	// open 派生自队列：App.tsx 的 onOpenChange(false) 手动关闭视为拒绝当前
	// 队首（fail-closed，与主进程超时语义一致），队列前进到下一条。
	const cancel = useCallback(() => {
		if (request) {
			void window.piDesktop.cua.sendApprovalResponse(request.requestId, {
				allowed: false,
				reason: "cancelled",
			});
		}
		setQueue((prev) => dequeueApproval(prev));
	}, [request]);

	const open = queue.length > 0;
	// 保持既有受控接口（App.tsx 传 onOpenChange={cuaApproval.setOpen}）：
	// 外部关闭请求 = 拒绝当前队首。
	const setOpen = useCallback(
		(nextOpen: boolean) => {
			if (!nextOpen) cancel();
		},
		[cancel],
	);

	return {
		request,
		pendingCount: queue.length,
		responding,
		open,
		setOpen,
		respond,
		cancel,
	};
}
